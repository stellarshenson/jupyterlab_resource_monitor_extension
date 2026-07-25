import os
import time

from jupyterlab_resource_monitor_extension.kernels import (
    _MAX_READS,
    _PAGE_SIZE,
    KernelSampler,
)


def write_proc(root, pid, rss_pages, utime, stime, children=()):
    """Lay down the three /proc files the sampler reads for one process."""
    base = root / "proc" / str(pid)
    base.mkdir(parents=True, exist_ok=True)
    (base / "statm").write_text(f"9999 {rss_pages} 0 0 0 0 0\n")
    # pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt
    # cmajflt utime stime ... - utime/stime are offsets 11/12 after the state
    (base / "stat").write_text(
        f"{pid} (python3) S 1 1 1 0 -1 0 0 0 0 0 {utime} {stime} 0 0\n"
    )
    task = base / "task" / str(pid)
    task.mkdir(parents=True, exist_ok=True)
    (task / "children").write_text(" ".join(str(c) for c in children))


def make_sampler(tmp_path, **kwargs):
    (tmp_path / "proc").mkdir(exist_ok=True)
    return KernelSampler(proc_root=str(tmp_path / "proc"), **kwargs)


def test_idle_without_a_watch(tmp_path):
    # no panel open means no kernel watched, so a tick walks nothing
    sampler = make_sampler(tmp_path)
    sampler.sample_once()
    assert sampler.snapshot("k1") == {"kernel": None, "ts": 0.0}


def test_sums_memory_over_the_process_tree(tmp_path):
    write_proc(tmp_path, 100, rss_pages=10, utime=0, stime=0, children=[200])
    write_proc(tmp_path, 200, rss_pages=5, utime=0, stime=0)
    sampler = make_sampler(tmp_path)
    sampler.watch("k1", "python3", 100)
    sampler.sample_once()

    kernel = sampler.snapshot("k1")["kernel"]
    assert kernel["id"] == "k1"
    assert kernel["name"] == "python3"
    assert kernel["memory_bytes"] == 15 * _PAGE_SIZE


def test_first_sample_reports_zero_cpu(tmp_path):
    write_proc(tmp_path, 100, rss_pages=10, utime=5000, stime=5000)
    sampler = make_sampler(tmp_path)
    sampler.watch("k1", "python3", 100)
    sampler.sample_once()
    # no baseline yet, so no since-start spike
    assert sampler.snapshot("k1")["kernel"]["cpu_percent"] == 0.0


def test_cpu_percent_from_the_tick_delta(tmp_path):
    write_proc(tmp_path, 100, rss_pages=10, utime=0, stime=0)
    sampler = make_sampler(tmp_path)
    sampler.watch("k1", "python3", 100)
    sampler.sample_once()  # baseline

    time.sleep(0.05)
    # burn one core for the elapsed wall time: ticks == CLK_TCK * seconds
    elapsed = 0.05
    ticks = int(100 * elapsed)
    write_proc(tmp_path, 100, rss_pages=10, utime=ticks, stime=0)
    sampler.sample_once()

    percent = sampler.snapshot("k1")["kernel"]["cpu_percent"]
    # A busy core over the interval. The band is wide on purpose: the wall time
    # is real, so a loaded CI runner that delays the second sample drags the
    # percentage down - the assertion is "it computed a delta", not a precise
    # rate.
    assert 0.0 < percent <= 200.0


def test_lease_expiry_stops_sampling(tmp_path):
    write_proc(tmp_path, 100, rss_pages=10, utime=0, stime=0)
    sampler = make_sampler(tmp_path, lease=-1.0)  # already expired on arrival
    sampler.watch("k1", "python3", 100)
    sampler.sample_once()
    # the closed panel stops polling, the lease lapses, nothing is sampled
    assert sampler.snapshot("k1")["kernel"] is None


def test_snapshot_never_serves_another_kernels_sample(tmp_path):
    write_proc(tmp_path, 100, rss_pages=10, utime=0, stime=0)
    sampler = make_sampler(tmp_path)
    sampler.watch("k1", "python3", 100)
    sampler.sample_once()
    assert sampler.snapshot("k1")["kernel"] is not None
    # switching notebooks must not show the previous kernel's numbers
    assert sampler.snapshot("k2")["kernel"] is None


def test_a_newly_watched_kernel_has_no_sample_until_it_is_walked(tmp_path):
    write_proc(tmp_path, 100, rss_pages=10, utime=0, stime=0)
    write_proc(tmp_path, 300, rss_pages=20, utime=0, stime=0)
    sampler = make_sampler(tmp_path)
    sampler.watch("k1", "python3", 100)
    sampler.sample_once()
    sampler.watch("k2", "python3", 300)
    # before the first sample of k2 lands, nothing is shown rather than k1's
    assert sampler.snapshot("k2")["kernel"] is None
    sampler.sample_once()
    assert sampler.snapshot("k2")["kernel"]["memory_bytes"] == 20 * _PAGE_SIZE


def test_two_watched_kernels_do_not_evict_each_other(tmp_path):
    # two notebooks open in two browser tabs, each panel polling for its own
    # kernel: a single-slot watch made every poll clear the other's sample, so
    # both panels sat on "Measuring..." forever
    write_proc(tmp_path, 100, rss_pages=10, utime=0, stime=0)
    write_proc(tmp_path, 300, rss_pages=20, utime=0, stime=0)
    sampler = make_sampler(tmp_path)

    sampler.watch("k1", "python3", 100)
    sampler.watch("k2", "python3", 300)
    sampler.sample_once()

    assert sampler.snapshot("k1")["kernel"]["memory_bytes"] == 10 * _PAGE_SIZE
    assert sampler.snapshot("k2")["kernel"]["memory_bytes"] == 20 * _PAGE_SIZE

    # and an interleaved poll from either tab keeps both readings alive
    sampler.watch("k1", "python3", 100)
    sampler.sample_once()
    assert sampler.snapshot("k1")["kernel"] is not None
    assert sampler.snapshot("k2")["kernel"] is not None


def test_expired_watch_does_not_evict_a_live_one(tmp_path):
    write_proc(tmp_path, 100, rss_pages=10, utime=0, stime=0)
    write_proc(tmp_path, 300, rss_pages=20, utime=0, stime=0)
    sampler = make_sampler(tmp_path)
    sampler.watch("k1", "python3", 100)
    sampler.sample_once()

    # k2's panel closes immediately (its lease is already past)
    with sampler._lock:
        sampler._watches["k2"] = ("python3", 300, time.monotonic() - 1)
    sampler.sample_once()

    assert sampler.snapshot("k2")["kernel"] is None
    assert sampler.snapshot("k1")["kernel"] is not None


def test_missing_proc_entry_degrades_to_zero(tmp_path):
    # the kernel died between the handler's lookup and the walk
    sampler = make_sampler(tmp_path)
    sampler.watch("k1", "python3", 4242)
    sampler.sample_once()
    kernel = sampler.snapshot("k1")["kernel"]
    assert kernel["memory_bytes"] == 0
    assert kernel["cpu_percent"] == 0.0


def test_walk_is_bounded(tmp_path):
    # a pathological fork chain must not make one sample unbounded; the budget
    # counts file reads, and each of these single-threaded processes costs
    # three (statm, stat, one task/*/children). The last process gets its two
    # unconditional reads and is then cut off before its children, so the walk
    # stops at exactly _MAX_READS // 3 + 1 - asserting the exact figure means a
    # silently tripled budget fails the test instead of sliding through.
    expected = _MAX_READS // 3 + 1
    depth = expected + 100
    for pid in range(1, depth + 1):
        children = [pid + 1] if pid < depth else []
        write_proc(tmp_path, pid, rss_pages=1, utime=0, stime=0, children=children)
    sampler = make_sampler(tmp_path)
    sampler.watch("k1", "python3", 1)
    sampler.sample_once()

    walked = sampler.snapshot("k1")["kernel"]["memory_bytes"] // _PAGE_SIZE
    assert walked == expected


def test_thread_enumeration_stops_at_the_budget(tmp_path, monkeypatch):
    # A heavily threaded kernel is the case the budget exists for, and the
    # thing that has to stop is the ENUMERATION, not just the reading: a glob
    # charges the same read count while still materialising (and sorting)
    # every thread dir first. So count directory entries actually consumed -
    # the only figure that tells the two apart.
    threads = 500
    write_proc(tmp_path, 1, rss_pages=1, utime=0, stime=0)
    task = tmp_path / "proc" / "1" / "task"
    for tid in range(2, threads + 2):
        (task / str(tid)).mkdir(parents=True)
        (task / str(tid) / "children").write_text("")
    sampler = make_sampler(tmp_path)

    consumed = 0
    real_scandir = os.scandir

    class _CountingScandir:
        def __init__(self, path):
            self._it = real_scandir(path)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self._it.close()
            return False

        def __iter__(self):
            nonlocal consumed
            for entry in self._it:
                consumed += 1
                yield entry

    monkeypatch.setattr(os, "scandir", _CountingScandir)
    budget = 50
    _, _, _, reads = sampler._read_proc(1, budget)

    assert reads == budget
    # 48 dirs read, plus the one the loop fetches before the break fires - 49
    # entries touched out of 501, where a glob would have touched all 501
    assert consumed == budget - 1


def test_stop_is_idempotent(tmp_path):
    sampler = make_sampler(tmp_path)
    sampler.stop()
    sampler.stop()
    assert sampler._stop_event.is_set()


def test_both_samplers_share_one_cadence():
    # the two intervals and the frontend POLL_INTERVAL are a load-bearing
    # coupling that nothing enforced - DEF-51 is what it looks like when they
    # drift - so the two Python defaults are now one constant
    from jupyterlab_resource_monitor_extension.metrics import (
        SAMPLE_INTERVAL,
        ResourceSampler,
    )

    assert ResourceSampler()._interval == KernelSampler()._interval
    assert KernelSampler()._interval == SAMPLE_INTERVAL
    # a lease shorter than the interval would expire between two polls
    assert KernelSampler()._lease > SAMPLE_INTERVAL
