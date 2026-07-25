"""Off-loop sampling for the kernels currently being watched.

Only kernels someone is actually looking at are sampled. The frontend names one
on each poll, which both registers it and renews a lease; when the panel closes
the polling stops, the lease lapses, and the sampler goes idle - walking nothing
at all. Watches are per kernel rather than a single slot, so two notebooks open
in two browser tabs each keep their own reading instead of evicting each other.

As with :mod:`.metrics`, no collection runs on the tornado event loop. The
handler only resolves a PID (an in-memory dict lookup) and reads the cache; the
``/proc`` tree walk, whose cost does scale with process count, happens on the
sampler thread.
"""

import os
import threading
import time

from .metrics import SAMPLE_INTERVAL


def _sysconf(name, default):
    """Read a sysconf value, falling back to the usual Linux constant.

    ``os.sysconf`` does not exist on Windows, and importing this module must
    never be what breaks the package there - the server extension as a whole
    would fail to load. It also returns -1, not 0, when a value is
    indeterminate, so anything non-positive takes the default.
    """
    try:
        value = os.sysconf(name)
    except (AttributeError, ValueError, OSError):
        return default
    return value if value > 0 else default


_CLK_TCK = _sysconf("SC_CLK_TCK", 100)
_PAGE_SIZE = _sysconf("SC_PAGE_SIZE", 4096)
# Cap the tree walk so a runaway fork tree cannot make one sample unbounded
# even off the event loop. The budget counts FILE READS, not processes: each
# process costs one `statm`, one `stat`, and one read per thread, so a
# 300-thread torch kernel costs far more than a single-threaded one and only a
# read budget bounds the real work.
_MAX_READS = 2000


def empty_snapshot():
    """The payload for "no reading for this kernel", defined once."""
    return {"kernel": None, "ts": 0.0}


class KernelSampler:
    """Samples the watched kernels' memory and CPU off the event loop."""

    def __init__(
        self,
        interval=SAMPLE_INTERVAL,
        proc_root="/proc",
        lease=SAMPLE_INTERVAL * 3,
        log=None,
    ):
        self._interval = interval
        self._proc_root = proc_root
        # A watch expires this long after the last poll, so a closed panel (no
        # more polls) stops the walking rather than sampling forever.
        self._lease = lease
        self._log = log
        self._warned = False
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread = None
        self._watches = {}  # kernel_id -> (name, pid, deadline)
        self._prev = {}  # kernel_id -> (cpu_ticks, monotonic) for the CPU delta
        self._samples = {}  # kernel_id -> {"kernel": {...}, "ts": float}

    def start(self):
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run, name="kernel-sampler", daemon=True
        )
        self._thread.start()

    def stop(self):
        """Signal the sampler thread to exit. Idempotent."""
        self._stop_event.set()

    def watch(self, kernel_id, name, pid):
        """Register a kernel to sample and renew its lease.

        Called from the request handler, so it must stay O(1) and do no I/O -
        it only stores what the sampler thread will use.
        """
        with self._lock:
            self._watches[kernel_id] = (
                name,
                pid,
                time.monotonic() + self._lease,
            )

    def snapshot(self, kernel_id):
        """Return the cached sample for one kernel, or an empty one.

        Samples are held per kernel, so a second panel watching a different
        kernel never displaces this one's reading.
        """
        with self._lock:
            sample = self._samples.get(kernel_id)
            if sample is None:
                return empty_snapshot()
            return {"kernel": dict(sample["kernel"]), "ts": sample["ts"]}

    def _run(self):
        # Same shape as the host sampler in metrics.py: sample, then wait. With
        # no watches registered sample_once is a no-op, so the leading sample
        # costs nothing here and keeps the two loops identical.
        while not self._stop_event.is_set():
            try:
                self.sample_once()
            except Exception:  # never let the sampling loop die
                # warn once, as the host sampler does: a persistent failure
                # would otherwise write a traceback every interval, forever
                if self._log is not None and not self._warned:
                    self._warned = True
                    self._log.warning(
                        "jupyterlab_resource_monitor_extension kernel sampler "
                        "failed, further failures will not be logged",
                        exc_info=True,
                    )
            self._stop_event.wait(self._interval)

    def sample_once(self):
        now = time.monotonic()
        with self._lock:
            # a lapsed lease means that panel is closed: drop the watch and
            # everything cached for it, so a reopen starts clean
            for kernel_id, (_, _, deadline) in list(self._watches.items()):
                if deadline < now:
                    del self._watches[kernel_id]
                    self._prev.pop(kernel_id, None)
                    self._samples.pop(kernel_id, None)
            live = [(k, v[0], v[1]) for k, v in self._watches.items()]

        # The walks happen outside the lock - it only guards the small dicts,
        # never the /proc reads, so a request never waits on file I/O.
        for kernel_id, name, pid in live:
            mem, cpu_ticks = self._read_tree(pid)
            # timed per kernel, right after its own walk: sharing one timestamp
            # across the loop would charge each kernel the walk time of the
            # ones before it
            read_at = time.monotonic()
            with self._lock:
                prev = self._prev.get(kernel_id)
                percent = 0.0
                if prev is not None:
                    prev_ticks, prev_time = prev
                    wall = read_at - prev_time
                    # a share of one core, like top: a multi-threaded kernel can
                    # exceed 100%, which the panel labels per kernel
                    if wall > 0 and cpu_ticks >= prev_ticks:
                        percent = (
                            (cpu_ticks - prev_ticks) / _CLK_TCK / wall * 100.0
                        )
                self._prev[kernel_id] = (cpu_ticks, read_at)
                self._samples[kernel_id] = {
                    "kernel": {
                        "id": kernel_id,
                        "name": name,
                        "memory_bytes": mem,
                        "cpu_percent": round(percent, 1),
                    },
                    "ts": time.time(),
                }

    def _read_tree(self, root_pid):
        """Sum RSS and CPU ticks over a process and its descendants.

        RSS is summed across the tree (shared pages counted once per process,
        as in the upstream extension) - good enough for a glanceable panel. The
        walk is bounded by ``_MAX_READS`` file reads, which is what actually
        costs time: a heavily threaded kernel spends most of it enumerating
        ``task/*/children``.
        """
        total_rss = 0
        total_ticks = 0
        stack = [root_pid]
        budget = _MAX_READS
        while stack and budget > 0:
            pid = stack.pop()
            rss, ticks, children, reads = self._read_proc(pid, budget)
            budget -= reads
            total_rss += rss
            total_ticks += ticks
            stack.extend(children)
        return total_rss, total_ticks

    def _read_proc(self, pid, budget):
        rss = 0
        ticks = 0
        children = []
        reads = 2  # statm and stat, below
        base = os.path.join(self._proc_root, str(pid))
        try:
            with open(os.path.join(base, "statm")) as f:
                rss = int(f.read().split()[1]) * _PAGE_SIZE
        except (OSError, ValueError, IndexError):
            pass
        try:
            with open(os.path.join(base, "stat")) as f:
                line = f.read()
            # comm (field 2) is parenthesised and may itself contain spaces or
            # ')', so parse after the last ')' to keep the offsets stable.
            # After it come state(3), ppid(4), ...; utime is field 14 and stime
            # field 15, i.e. offsets 11 and 12 counting state as 0.
            after = line[line.rfind(")") + 2 :].split()
            ticks = int(after[11]) + int(after[12])
        except (OSError, ValueError, IndexError):
            pass
        # scandir rather than glob: glob materialises (and sorts) the whole
        # thread list before the first budget check, so a 5000-thread process
        # would cost 5000 uncharged directory entries no matter the budget.
        # Iterating charges one read per thread dir and stops when spent.
        try:
            with os.scandir(os.path.join(base, "task")) as entries:
                for entry in entries:
                    if reads >= budget:
                        break
                    reads += 1
                    try:
                        with open(os.path.join(entry.path, "children")) as f:
                            children.extend(int(p) for p in f.read().split())
                    except (OSError, ValueError):
                        pass
        except OSError:
            pass
        return rss, ticks, children, reads
