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

# Both samplers tick at the rate the frontend polls at (state.ts POLL_INTERVAL).
# Sampling faster than that does work nobody reads; slower, and a poll can
# return a reading older than the interval it was promised.
SAMPLE_INTERVAL = 5.0


def _parse_cpu_list(text):
    """CPU indices in a cgroup cpu list like ``0-3,8,12-15``, or None.

    The indices match the ``cpuN`` line numbers in ``/proc/stat`` (which is not
    namespaced inside a container), so one list names both the count and the
    identity of the cores.
    """
    ids = []
    for part in text.split(","):
        lo, _, hi = part.partition("-")
        try:
            ids.extend(range(int(lo), int(hi) + 1) if hi else [int(lo)])
        except ValueError:
            return None
    return sorted(ids) or None


class ResourceSampler:
    """Samples memory and CPU usage off the event loop and caches a snapshot.

    Memory follows the cadvisor "working set" convention: cgroup
    ``memory.current`` minus reclaimable page cache (``inactive_file``),
    against the cgroup limit ``memory.max`` (host ``MemTotal`` when
    unlimited). CPU is the delta of cgroup ``cpu.stat`` ``usage_usec``
    against wall time and the effective CPU count from ``cpu.max``.
    Without cgroup v2, falls back to ``/proc/meminfo`` and ``/proc/stat``.
    """

    def __init__(self, interval=SAMPLE_INTERVAL, cgroup_root="/sys/fs/cgroup",
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
        self._prev_cores = {}  # {cpu index: (busy, total)} for per-core deltas
        self._warned = False
        self._snapshot = {
            "mem": {"used_bytes": 0, "total_bytes": 0, "limit_source": "host"},
            "cpu": {
                "percent": 0.0,
                "cpu_count": os.cpu_count() or 1,
                "per_core": None,
            },
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
                        "jupyterlab_resource_monitor_extension sampler "
                        "failed, further failures will not be logged",
                        exc_info=True,
                    )
            self._stop_event.wait(self._interval)

    def sample_once(self):
        used, total, limit_source = self._read_memory()
        percent, cpu_count, core_ids = self._read_cpu()
        snap = {
            "mem": {
                "used_bytes": used,
                "total_bytes": total,
                "limit_source": limit_source,
            },
            "cpu": {
                "percent": percent,
                "cpu_count": cpu_count,
                "per_core": self._per_core_percent(core_ids),
            },
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
        """``(percent, cpu_count, ids)`` - the reading and what it is taken over.

        The core set travels with the count it belongs to, so whichever branch
        produces the percentage also decides which cores the grid may draw.
        """
        cpu_count, ids = self._cpu_scope()
        usage_usec = self._read_stat_key(
            self._cgroup_path("cpu.stat"), "usage_usec"
        )
        if usage_usec is not None:
            now = time.monotonic()
            prev = self._prev_cpu
            self._prev_cpu = ("cgroup", usage_usec, now)
            if prev is None or prev[0] != "cgroup":
                return 0.0, cpu_count, ids
            _, prev_usage, prev_time = prev
            wall_usec = (now - prev_time) * 1e6 * cpu_count
            if wall_usec <= 0:
                return 0.0, cpu_count, ids
            percent = (usage_usec - prev_usage) / wall_usec * 100.0
            return round(min(max(percent, 0.0), 100.0), 1), cpu_count, ids

        busy, total = self._read_proc_stat()
        # /proc/stat's aggregate line is unconditionally machine-wide, so the
        # denominator has to be too - no cgroup or affinity narrowing applies
        # to a numerator that already counted every CPU on the box. The cells
        # move with it, or the grid would again describe a narrower population
        # than the number beside it.
        cpu_count = os.cpu_count() or 1
        ids = list(range(cpu_count))
        if total <= 0:
            # transient /proc/stat read failure returns the (0, 0) sentinel;
            # keep the previous baseline so the next delta is real rather than
            # a since-boot spike computed against a zero baseline
            return 0.0, cpu_count, ids
        prev = self._prev_cpu
        self._prev_cpu = ("proc", busy, total)
        if prev is None or prev[0] != "proc":
            return 0.0, cpu_count, ids
        _, prev_busy, prev_total = prev
        delta_total = total - prev_total
        if delta_total <= 0:
            return 0.0, cpu_count, ids
        percent = (busy - prev_busy) / delta_total * 100.0
        return round(min(max(percent, 0.0), 100.0), 1), cpu_count, ids

    def _cpu_quota(self):
        """CPU bandwidth ceiling from cgroup ``cpu.max``, or None if unlimited.

        A quota caps total CPU time without pinning it to particular cores, so
        it names how much this server may use but not which cores it runs on.
        """
        text = self._read_text(self._cgroup_path("cpu.max"))
        if text is None:
            return None
        parts = text.split()
        if len(parts) != 2 or parts[0] == "max":
            return None
        try:
            quota, period = int(parts[0]), int(parts[1])
        except ValueError:
            return None
        if period <= 0:
            return None
        return max(quota / period, 0.1)

    def _cpuset_cpus(self):
        """Cores this cgroup's processes may run on, or None if unreadable.

        Read from the cgroup rather than from this task's affinity mask,
        because ``cpu.stat`` counts every process in the cgroup - not just this
        one - so the cgroup's own cpuset is the population its usage is spread
        over. A task narrowed further by ``taskset`` does not narrow that.
        """
        text = self._read_text(self._cgroup_path("cpuset.cpus.effective"))
        return _parse_cpu_list(text) if text else None

    def _cpu_scope(self):
        """``(capacity, ids)`` - the CPU ceiling and the cores it counts.

        Resolved together, once per tick, because resolving them apart is what
        produced DEF-55 and DEF-58: two functions that had to agree, and twice
        did not. Whenever ``ids`` is not None, ``capacity == len(ids)`` by
        construction - the grid and the number beside it describing different
        populations is not a case this can express.

        The capacity must describe the same population as the numerator, which
        for ``cpu.stat`` is the whole cgroup - so the cores are the cgroup's
        own cpuset, never this task's affinity mask, which narrows one process
        and pinned an idle 64-core host at 100% under ``taskset`` (DEF-53).

        ``ids`` is None where the ceiling is a slice of time rather than a set
        of cores. A quota below the core count cannot saturate them, so no
        arrangement of cells represents it and the item falls back to the bar.
        """
        ids = self._cpuset_cpus() or list(range(os.cpu_count() or 1))
        quota = self._cpu_quota()
        if quota is not None and quota < len(ids):
            return quota, None
        # a quota at or above the core count buys no more than the cores can
        # deliver, so the cores are the ceiling and the quota is not binding
        return len(ids), ids

    def _cpu_times(self, fields):
        """(busy, total) from one ``/proc/stat`` cpu line, or None if unusable.

        Sums only user..steal (fields 0-7); guest and guest_nice (8-9) are
        already folded into user/nice by the kernel, so including them would
        double-count and inflate the denominator.
        """
        if len(fields) < 4:
            return None
        total = sum(fields[:8])
        idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
        return total - idle, total

    def _read_proc_stat(self):
        try:
            with open(os.path.join(self._proc_root, "stat")) as f:
                fields = [int(v) for v in f.readline().split()[1:]]
        except (OSError, ValueError):
            return 0, 0
        # a masked or truncated /proc/stat (e.g. a /dev/null bind-mount, which
        # opens and reads fine) has no idle column - take the sentinel so CPU
        # degrades to 0 and the memory reading still gets through
        return self._cpu_times(fields) or (0, 0)

    # -- per-core cpu ------------------------------------------------------

    def _read_per_core(self, ids):
        """Return ``{cpu index: (busy, total)}`` for `ids` from ``/proc/stat``.

        Stops at the first non-``cpu`` line. The ``intr`` line immediately after
        them carries one counter per IRQ - hundreds of fields on a large box -
        and parsing it every tick would be the single unbounded read in an
        otherwise fixed-cost collector.
        """
        wanted = set(ids)
        times = {}
        try:
            with open(os.path.join(self._proc_root, "stat")) as f:
                for line in f:
                    if not line.startswith("cpu"):
                        break
                    name, _, rest = line.partition(" ")
                    if name == "cpu":
                        continue  # the aggregate line, read separately
                    try:
                        index = int(name[3:])
                    except ValueError:
                        continue
                    if index not in wanted:
                        continue
                    try:
                        fields = [int(v) for v in rest.split()]
                    except ValueError:
                        continue
                    pair = self._cpu_times(fields)
                    if pair is not None:
                        times[index] = pair
        except (OSError, ValueError):
            # ValueError covers the decode: a masked or binary /proc/stat
            # raises during iteration, and letting it escape would abort the
            # whole sample and take the working memory reading down with it
            return {}
        return times

    @staticmethod
    def _core_percent(prev, cur):
        """One core's busy share of its own elapsed time, 0-100.

        A core missing from either sample - offline, or hotplugged away between
        ticks - reads 0 rather than dropping out, so the list keeps its length
        and cores do not shift position under the display.
        """
        if prev is None or cur is None:
            return 0.0
        delta_total = cur[1] - prev[1]
        if delta_total <= 0:
            return 0.0
        busy = (cur[0] - prev[0]) / delta_total * 100.0
        return round(min(max(busy, 0.0), 100.0), 1)

    def _per_core_percent(self, ids):
        """Busy percentage of each core in ``ids``, or None when there are none.

        ``ids`` comes from `_read_cpu`, which is what guarantees these cells
        cover exactly the cores the published percentage was divided by rather
        than a set that merely ought to match it.

        None means the ceiling was a slice of time rather than a set of cores,
        so there is nothing honest to attribute and the item draws the bar.
        """
        if ids is None:
            # drop the baseline with the regime: on the way back out, the first
            # tick has to read against a fresh sample rather than average
            # across however long the bar was on screen
            self._prev_cores = {}
            return None
        times = self._read_per_core(ids)
        if not times:
            # Same discipline as the aggregate (DEF-23): a transient read
            # failure must not overwrite the baseline, or the recovery tick
            # computes against nothing and draws an all-dark grid while the
            # tooltip reports a saturated machine.
            return None
        prev, self._prev_cores = self._prev_cores, times
        return [self._core_percent(prev.get(i), times.get(i)) for i in ids]

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
