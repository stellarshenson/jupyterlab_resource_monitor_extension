"""Bounded-cost resource sampler.

Design mandate: metrics collection is O(1) - a fixed set of small file reads
from cgroup v2 (container-aware) with /proc fallback - and never runs on the
tornado event loop. A daemon thread samples on a fixed cadence and caches a
snapshot; request handlers only return the cache. Cost is independent of the
number of processes on the system (no /proc/<pid> tree walks, no psutil).
"""

import os
import threading
import time


class ResourceSampler:
    """Samples memory and CPU usage off the event loop and caches a snapshot.

    Memory follows the cadvisor "working set" convention: cgroup
    ``memory.current`` minus reclaimable page cache (``inactive_file``),
    against the cgroup limit ``memory.max`` (host ``MemTotal`` when
    unlimited). CPU is the delta of cgroup ``cpu.stat`` ``usage_usec``
    against wall time and the effective CPU count from ``cpu.max``.
    Without cgroup v2, falls back to ``/proc/meminfo`` and ``/proc/stat``.
    """

    def __init__(self, interval=5.0, cgroup_root="/sys/fs/cgroup",
                 proc_root="/proc", log=None):
        self._interval = interval
        self._cgroup_root = cgroup_root
        self._proc_root = proc_root
        self._log = log
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread = None
        self._cgroup_dir = None  # resolved lazily from /proc/self/cgroup
        self._prev_cpu = None  # (source, busy, total) for delta computation
        self._warned = False
        self._snapshot = {
            "mem": {"used_bytes": 0, "total_bytes": 0, "limit_source": "host"},
            "cpu": {"percent": 0.0, "cpu_count": os.cpu_count() or 1},
            "ts": 0.0,
        }

    def start(self):
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run, name="resource-monitor-sampler", daemon=True
        )
        self._thread.start()

    def stop(self):
        """Signal the sampler thread to exit. Idempotent."""
        self._stop_event.set()

    def snapshot(self):
        """Return the latest cached sample. Cheap; safe on the event loop."""
        with self._lock:
            # The sampler replaces the whole dict and never mutates nested
            # values in place, so a shallow copy is safe to hand out.
            return dict(self._snapshot)

    # -- sampling thread ---------------------------------------------------

    def _run(self):
        while not self._stop_event.is_set():
            try:
                self.sample_once()
            except Exception:
                if self._log is not None and not self._warned:
                    self._warned = True
                    self._log.warning(
                        "jupyterlab_resource_monitor_extension sampler failed",
                        exc_info=True,
                    )
            self._stop_event.wait(self._interval)

    def sample_once(self):
        used, total, limit_source = self._read_memory()
        percent, cpu_count = self._read_cpu()
        snap = {
            "mem": {
                "used_bytes": used,
                "total_bytes": total,
                "limit_source": limit_source,
            },
            "cpu": {"percent": percent, "cpu_count": cpu_count},
            "ts": time.time(),
        }
        with self._lock:
            self._snapshot = snap

    # -- memory ------------------------------------------------------------

    def _read_memory(self):
        """Return (used_bytes, total_bytes, limit_source).

        limit_source is "cgroup" when total is this process's own cgroup
        limit (a real container ceiling) and "host" when it is the machine's
        physical RAM.
        """
        current = self._read_int(self._cgroup_path("memory.current"))
        if current is not None:
            inactive_file = self._read_stat_key(
                self._cgroup_path("memory.stat"), "inactive_file"
            )
            used = max(current - (inactive_file or 0), 0)
            limit = self._read_int(self._cgroup_path("memory.max"))
            if limit is not None:
                return used, limit, "cgroup"
            # memory.max == "max" (unlimited) or unreadable -> host total
            total, _available = self._read_meminfo()
            return used, total, "host"
        total, available = self._read_meminfo()
        return max(total - available, 0), total, "host"

    def _read_meminfo(self):
        total = available = free = 0
        have_available = False
        try:
            with open(os.path.join(self._proc_root, "meminfo")) as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        total = int(line.split()[1]) * 1024
                    elif line.startswith("MemAvailable:"):
                        available = int(line.split()[1]) * 1024
                        have_available = True
                    elif line.startswith("MemFree:"):
                        free = int(line.split()[1]) * 1024
        except (OSError, ValueError, IndexError):
            pass
        # MemAvailable is the kernel's reclaim-aware estimate but is absent on
        # kernels < 3.14; fall back to MemFree so "used" is not reported as the
        # full total (which would pin the bar at 100%).
        if not have_available:
            available = free
        return total, available

    # -- cpu ---------------------------------------------------------------

    def _read_cpu(self):
        usage_usec = self._read_stat_key(
            self._cgroup_path("cpu.stat"), "usage_usec"
        )
        if usage_usec is not None:
            cpu_count = self._effective_cpu_count()
            now = time.monotonic()
            prev = self._prev_cpu
            self._prev_cpu = ("cgroup", usage_usec, now)
            if prev is None or prev[0] != "cgroup":
                return 0.0, cpu_count
            _, prev_usage, prev_time = prev
            wall_usec = (now - prev_time) * 1e6 * cpu_count
            if wall_usec <= 0:
                return 0.0, cpu_count
            percent = (usage_usec - prev_usage) / wall_usec * 100.0
            return round(min(max(percent, 0.0), 100.0), 1), cpu_count

        busy, total = self._read_proc_stat()
        cpu_count = os.cpu_count() or 1
        if total <= 0:
            # transient /proc/stat read failure returns the (0, 0) sentinel;
            # keep the previous baseline so the next delta is real rather than
            # a since-boot spike computed against a zero baseline
            return 0.0, cpu_count
        prev = self._prev_cpu
        self._prev_cpu = ("proc", busy, total)
        if prev is None or prev[0] != "proc":
            return 0.0, cpu_count
        _, prev_busy, prev_total = prev
        delta_total = total - prev_total
        if delta_total <= 0:
            return 0.0, cpu_count
        percent = (busy - prev_busy) / delta_total * 100.0
        return round(min(max(percent, 0.0), 100.0), 1), cpu_count

    def _effective_cpu_count(self):
        text = self._read_text(self._cgroup_path("cpu.max"))
        if text is not None:
            parts = text.split()
            if len(parts) == 2 and parts[0] != "max":
                try:
                    quota, period = int(parts[0]), int(parts[1])
                except ValueError:
                    return os.cpu_count() or 1
                if period > 0:
                    return max(quota / period, 0.1)
        return os.cpu_count() or 1

    def _read_proc_stat(self):
        try:
            with open(os.path.join(self._proc_root, "stat")) as f:
                fields = [int(v) for v in f.readline().split()[1:]]
        except (OSError, ValueError):
            return 0, 0
        if len(fields) < 4:
            # a masked or truncated /proc/stat (e.g. a /dev/null bind-mount,
            # which opens and reads fine) has no idle column - take the sentinel
            # so CPU degrades to 0 and the memory reading still gets through
            return 0, 0
        # Sum only user..steal (fields 0-7); guest and guest_nice (8-9) are
        # already folded into user/nice by the kernel, so including them would
        # double-count and inflate the denominator.
        total = sum(fields[:8])
        idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
        return total - idle, total

    # -- small file helpers ------------------------------------------------

    def _cgroup_path(self, name):
        if self._cgroup_dir is None:
            self._cgroup_dir = self._resolve_cgroup_dir()
        return os.path.join(self._cgroup_dir, name)

    def _resolve_cgroup_dir(self):
        """Locate this process's own cgroup v2 directory.

        In a private cgroup namespace (Docker/K8s default) the process sits at
        the mount root and ``/proc/self/cgroup`` reads ``0::/``. Under
        ``--cgroupns=host`` or systemd spawners the process lives in a subpath
        (e.g. ``/user.slice/...``) and only that subdirectory carries the real
        ``memory.max`` limit - reading the mount root there would report
        host-wide numbers and hide the container limit. Resolve the real
        directory once, falling back to the mount root.
        """
        try:
            with open(os.path.join(self._proc_root, "self", "cgroup")) as f:
                for line in f:
                    parts = line.strip().split(":", 2)
                    if len(parts) == 3 and parts[0] == "0":
                        rel = parts[2].lstrip("/")
                        candidate = os.path.join(self._cgroup_root, rel)
                        if os.path.exists(
                            os.path.join(candidate, "memory.current")
                        ):
                            return candidate
        except OSError:
            pass
        return self._cgroup_root

    def _read_text(self, path):
        try:
            with open(path) as f:
                return f.read().strip()
        except OSError:
            return None

    def _read_int(self, path):
        text = self._read_text(path)
        if text is None:
            return None
        try:
            return int(text)
        except ValueError:
            return None

    def _read_stat_key(self, path, key):
        try:
            with open(path) as f:
                for line in f:
                    if line.startswith(key + " "):
                        return int(line.split()[1])
        except (OSError, ValueError, IndexError):
            pass
        return None
