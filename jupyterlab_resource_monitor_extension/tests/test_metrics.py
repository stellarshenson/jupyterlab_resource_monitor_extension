import os
import time

import pytest

from jupyterlab_resource_monitor_extension.metrics import ResourceSampler


def make_sampler(tmp_path, cgroup_files=None, proc_files=None):
    cgroup = tmp_path / "cgroup"
    proc = tmp_path / "proc"
    cgroup.mkdir(exist_ok=True)
    proc.mkdir(exist_ok=True)
    for name, content in (cgroup_files or {}).items():
        path = cgroup / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    for name, content in (proc_files or {}).items():
        path = proc / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    return ResourceSampler(cgroup_root=str(cgroup), proc_root=str(proc))


MEMINFO = "MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\n"


def test_cgroup_memory_working_set(tmp_path):
    sampler = make_sampler(
        tmp_path,
        cgroup_files={
            "memory.current": "2147483648\n",
            "memory.stat": "anon 1000\ninactive_file 1073741824\n",
            "memory.max": "8589934592\n",
        },
    )
    used, total, source = sampler._read_memory()
    assert used == 2147483648 - 1073741824
    assert total == 8589934592
    assert source == "cgroup"


def test_cgroup_memory_unlimited_falls_back_to_meminfo(tmp_path):
    sampler = make_sampler(
        tmp_path,
        cgroup_files={
            "memory.current": "1073741824\n",
            "memory.stat": "inactive_file 0\n",
            "memory.max": "max\n",
        },
        proc_files={"meminfo": MEMINFO},
    )
    used, total, _source = sampler._read_memory()
    assert used == 1073741824
    assert total == 16384000 * 1024


def test_proc_memory_fallback(tmp_path):
    sampler = make_sampler(tmp_path, proc_files={"meminfo": MEMINFO})
    used, total, source = sampler._read_memory()
    assert total == 16384000 * 1024
    assert used == (16384000 - 8192000) * 1024
    assert source == "host"


def test_proc_memory_fallback_without_memavailable(tmp_path):
    # pre-3.14 kernels have no MemAvailable; fall back to MemFree rather than
    # reporting the whole total as used (which would pin the bar at 100%)
    sampler = make_sampler(
        tmp_path,
        proc_files={
            "meminfo": "MemTotal:       16384000 kB\nMemFree:         2048000 kB\n"
        },
    )
    used, total, _source = sampler._read_memory()
    assert total == 16384000 * 1024
    assert used == (16384000 - 2048000) * 1024
    assert used < total


def test_cgroup_cpu_first_sample_is_zero(tmp_path, monkeypatch):
    # the quota is clamped against the machine, so the machine has to be pinned
    # or this asserts 2 on an 8-core box and 1 on a single-core CI runner
    monkeypatch.setattr(os, "cpu_count", lambda: 8)
    sampler = make_sampler(
        tmp_path,
        cgroup_files={
            "cpu.stat": "usage_usec 1000000\n",
            "cpu.max": "200000 100000\n",
        },
    )
    percent, cpu_count, _ids = sampler._read_cpu()
    assert percent == 0.0
    assert cpu_count == 2


def test_cgroup_cpu_delta(tmp_path, monkeypatch):
    sampler = make_sampler(
        tmp_path,
        cgroup_files={
            "cpu.stat": "usage_usec 1000000\n",
            "cpu.max": "200000 100000\n",
        },
    )
    monkeypatch.setattr(os, "cpu_count", lambda: 8)  # see above: quota is clamped
    monkeypatch.setattr(time, "monotonic", lambda: 100.0)
    sampler._read_cpu()
    # one second later, one full CPU of the two was busy -> 50%
    (tmp_path / "cgroup" / "cpu.stat").write_text("usage_usec 2000000\n")
    monkeypatch.setattr(time, "monotonic", lambda: 101.0)
    percent, cpu_count, _ids = sampler._read_cpu()
    assert cpu_count == 2
    assert percent == 50.0


def test_proc_cpu_fallback_delta(tmp_path):
    sampler = make_sampler(
        tmp_path,
        proc_files={"stat": "cpu  100 0 100 700 100 0 0 0 0 0\n"},
    )
    percent, _count, _ids = sampler._read_cpu()
    assert percent == 0.0
    # busy delta 100, total delta 200 -> 50%
    (tmp_path / "proc" / "stat").write_text("cpu  200 0 100 800 100 0 0 0 0 0\n")
    percent, _count, _ids = sampler._read_cpu()
    assert percent == 50.0


def test_percent_clamped(tmp_path, monkeypatch):
    sampler = make_sampler(
        tmp_path,
        cgroup_files={
            "cpu.stat": "usage_usec 0\n",
            "cpu.max": "100000 100000\n",
        },
    )
    monkeypatch.setattr(time, "monotonic", lambda: 100.0)
    sampler._read_cpu()
    # implausibly large delta clamps to 100
    (tmp_path / "cgroup" / "cpu.stat").write_text("usage_usec 999000000\n")
    monkeypatch.setattr(time, "monotonic", lambda: 101.0)
    percent, _count, _ids = sampler._read_cpu()
    assert percent == 100.0


def test_sample_once_updates_snapshot(tmp_path):
    sampler = make_sampler(tmp_path, proc_files={"meminfo": MEMINFO})
    assert sampler.snapshot()["ts"] == 0.0
    sampler.sample_once()
    snap = sampler.snapshot()
    assert snap["ts"] > 0.0
    assert snap["mem"]["total_bytes"] == 16384000 * 1024


def test_snapshot_is_cached_not_collected(tmp_path):
    sampler = make_sampler(tmp_path, proc_files={"meminfo": MEMINFO})
    sampler.sample_once()
    first = sampler.snapshot()
    # change the underlying files; snapshot must not change until next sample
    (tmp_path / "proc" / "meminfo").write_text(
        "MemTotal:       32768000 kB\nMemAvailable:    1000 kB\n"
    )
    assert sampler.snapshot() == first


def test_cgroup_self_resolution(tmp_path):
    # process lives in a sub-cgroup (cgroupns=host / systemd spawner); only the
    # subdir carries the real limit, the mount root does not
    sampler = make_sampler(
        tmp_path,
        proc_files={"self/cgroup": "0::/user.slice/jupyter\n", "meminfo": MEMINFO},
    )
    sub = tmp_path / "cgroup" / "user.slice" / "jupyter"
    sub.mkdir(parents=True)
    (sub / "memory.current").write_text("4000000000\n")
    (sub / "memory.stat").write_text("inactive_file 0\n")
    (sub / "memory.max").write_text("8000000000\n")
    used, total, _source = sampler._read_memory()
    assert used == 4000000000
    assert total == 8000000000


def test_malformed_memory_max_falls_back(tmp_path):
    sampler = make_sampler(
        tmp_path,
        cgroup_files={
            "memory.current": "1073741824\n",
            "memory.stat": "inactive_file 0\n",
            "memory.max": "garbage\n",
        },
        proc_files={"meminfo": MEMINFO},
    )
    used, total, _source = sampler._read_memory()
    assert used == 1073741824
    assert total == 16384000 * 1024  # fell back to host MemTotal, no ValueError


def test_malformed_cpu_max_falls_back(tmp_path):
    sampler = make_sampler(
        tmp_path,
        cgroup_files={
            "cpu.stat": "usage_usec 1000000\n",
            "cpu.max": "abc 100000\n",
        },
    )
    # must not raise; with no usable quota and no cpuset the ceiling is the host
    assert sampler._cpu_scope()[0] == (os.cpu_count() or 1)


def test_proc_stat_excludes_guest_time(tmp_path):
    sampler = make_sampler(
        tmp_path,
        proc_files={"stat": "cpu  100 0 100 700 100 0 0 0 500 0\n"},
    )
    assert sampler._read_cpu()[0] == 0.0
    # busy delta 100, total delta 200 -> 50%; guest jump 500->900 is ignored
    (tmp_path / "proc" / "stat").write_text("cpu  200 0 100 800 100 0 0 0 900 0\n")
    assert sampler._read_cpu()[0] == 50.0


def test_proc_stat_transient_failure_does_not_spike(tmp_path):
    sampler = make_sampler(
        tmp_path,
        proc_files={"stat": "cpu  100 0 100 700 100 0 0 0 0 0\n"},
    )
    sampler._read_cpu()  # establish baseline
    # transient read failure: remove /proc/stat -> (0, 0) sentinel
    (tmp_path / "proc" / "stat").unlink()
    assert sampler._read_cpu()[0] == 0.0  # no since-boot spike
    # baseline preserved, so the next real read computes a true delta
    (tmp_path / "proc" / "stat").write_text("cpu  200 0 100 800 100 0 0 0 0 0\n")
    assert sampler._read_cpu()[0] == 50.0


@pytest.mark.parametrize("stat", ["", "cpu  100 0 100\n"])
def test_proc_stat_without_idle_column_degrades(tmp_path, stat):
    # a masked (/dev/null bind-mount) or truncated /proc/stat reads fine but
    # has no idle column - it must take the sentinel path, not raise and
    # discard the memory reading collected earlier in the same sample
    sampler = make_sampler(
        tmp_path,
        proc_files={"stat": stat, "meminfo": MEMINFO},
    )
    assert sampler._read_proc_stat() == (0, 0)
    assert sampler._read_cpu()[0] == 0.0
    sampler.sample_once()
    assert sampler.snapshot()["mem"]["total_bytes"] > 0


def test_stat_key_without_value_returns_none(tmp_path):
    sampler = make_sampler(tmp_path, cgroup_files={"cpu.stat": "usage_usec \n"})
    assert sampler._read_stat_key(str(tmp_path / "cgroup" / "cpu.stat"), "usage_usec") is None


def test_stop_is_idempotent(tmp_path):
    sampler = make_sampler(tmp_path)
    sampler.stop()
    sampler.stop()  # second call must not raise
    assert sampler._stop_event.is_set()


# -- per-core cpu ---------------------------------------------------------

# Four cores plus the aggregate. The lines after them are what /proc/stat
# really carries, and `intr` is the reason the reader has to stop: it holds one
# counter per IRQ, hundreds of fields on a large machine.
def proc_stat(cpu0_busy, extra=""):
    return (
        "cpu  400 0 400 2800 400 0 0 0 0 0\n"
        f"cpu0 {cpu0_busy} 0 100 700 100 0 0 0 0 0\n"
        "cpu1 100 0 100 800 100 0 0 0 0 0\n"
        "cpu2 100 0 100 800 100 0 0 0 0 0\n"
        "cpu3 100 0 100 800 100 0 0 0 0 0\n"
        f"{extra}"
        "intr 12345 1 2 3 4 5 6 7 8 9\n"
        "ctxt 999999\n"
        "procs_running 2\n"
    )


def per_core(sampler):
    """The cells this sampler would publish, routed the way it publishes them.

    Goes through `_read_cpu` rather than calling `_per_core_percent` with a
    hand-made core set, so every per-core test exercises the scope resolution
    that decides both the cells and the denominator - the seam DEF-55 and
    DEF-58 opened up.
    """
    return sampler._per_core_percent(sampler._read_cpu()[2])


def cpuset(ids):
    """cgroup files putting the reading on exactly these cores.

    The core set comes from a real file the sampler parses rather than from a
    mocked helper, so these exercise the read-and-parse path it actually uses.

    `cpu.stat` is part of it deliberately: a cpuset only describes the
    population when the numerator is the cgroup's own usage. Without it the
    percentage comes from machine-wide `/proc/stat`, and the cells follow it
    there rather than staying on a cpuset that no longer bounds the reading.
    """
    return {
        "cpu.stat": "usage_usec 0\n",
        "cpuset.cpus.effective": ",".join(str(i) for i in ids) + "\n",
    }


def test_per_core_first_sample_is_zero(tmp_path):
    sampler = make_sampler(
        tmp_path,
        cgroup_files=cpuset([0, 1, 2, 3]),
        proc_files={"stat": proc_stat(100)},
    )
    # no baseline yet, so no since-boot spike - same discipline as the aggregate
    assert per_core(sampler) == [0.0, 0.0, 0.0, 0.0]


def test_per_core_reports_each_core_on_its_own_scale(tmp_path):
    sampler = make_sampler(
        tmp_path,
        cgroup_files=cpuset([0, 1, 2, 3]),
        proc_files={"stat": proc_stat(100)},
    )
    per_core(sampler)  # baseline

    # cpu0 busy delta 100 over total delta 200 -> 50%; the rest only idled
    (tmp_path / "proc" / "stat").write_text(
        proc_stat(100).replace(
            "cpu0 100 0 100 700 100", "cpu0 200 0 100 800 100"
        )
    )
    assert per_core(sampler) == [50.0, 0.0, 0.0, 0.0]


def test_per_core_covers_only_the_assigned_cores(tmp_path):
    # A cpuset container sees every host cpu in /proc/stat but owns two. The
    # load has to be non-zero and asymmetric: against all-idle data a reader
    # that keys cores by list position rather than by CPU index returns the
    # same [0.0, 0.0], so the assertion would pass while the grid attributed
    # every core's load to the wrong cell.
    sampler = make_sampler(
        tmp_path,
        cgroup_files=cpuset([1, 2]),
        proc_files={"stat": proc_stat(100)},
    )
    per_core(sampler)

    # cpu0 and cpu3 saturate, cpu1 takes half, cpu2 stays idle - so a reader
    # keyed by rank would report cpu0's 100 in the first slot
    (tmp_path / "proc" / "stat").write_text(
        "cpu  400 0 400 2800 400 0 0 0 0 0\n"
        "cpu0 200 0 100 700 100 0 0 0 0 0\n"
        "cpu1 150 0 100 850 100 0 0 0 0 0\n"
        "cpu2 100 0 100 900 100 0 0 0 0 0\n"
        "cpu3 200 0 100 800 100 0 0 0 0 0\n"
        "intr 12345 1 2 3 4 5 6 7 8 9\n"
    )
    assert per_core(sampler) == [50.0, 0.0]


def test_per_core_parses_only_the_assigned_cores(tmp_path):
    # The filter cannot be seen in _per_core_percent's output - the result is
    # projected through `ids` either way - so the thing to pin is the work
    # done. Dropped, a 2-core cpuset on a 128-core host parses 128 lines every
    # tick instead of 2: the DEF-44/45 class of unbounded-cost regression.
    sampler = make_sampler(
        tmp_path,
        cgroup_files=cpuset([1, 2]),
        proc_files={"stat": proc_stat(100)},
    )
    assert set(sampler._read_per_core([1, 2])) == {1, 2}


def test_off_linux_reports_no_per_core(tmp_path):
    # no /proc to read: every per-core figure is unavailable, and returning a
    # short or zeroed list instead would draw a dark grid rather than the bar
    sampler = make_sampler(tmp_path, cgroup_files=cpuset([0, 1, 2, 3]))
    assert per_core(sampler) is None


def test_per_core_survives_an_undecodable_proc_stat(tmp_path):
    # DEF-57: the decode raises ValueError, not OSError. Escaping _read_per_core
    # it aborts sample_once entirely - the snapshot timestamp stops advancing
    # and the frontend hides BOTH items, taking a perfectly good memory reading
    # down with a CPU read that should have degraded to nothing on its own.
    sampler = make_sampler(tmp_path, cgroup_files=cpuset([0, 1]))
    (tmp_path / "proc" / "stat").write_bytes(b"cpu0 \xff\xfe 1 2 3\n")
    assert per_core(sampler) is None


def test_transient_read_failure_keeps_the_per_core_baseline(tmp_path):
    # same discipline as the aggregate (DEF-23): clobbering the baseline on a
    # bad read makes the recovery tick compute against nothing, so a saturated
    # machine draws an all-dark grid under a 100% tooltip
    sampler = make_sampler(
        tmp_path,
        cgroup_files=cpuset([0, 1, 2, 3]),
        proc_files={"stat": proc_stat(100)},
    )
    per_core(sampler)  # baseline

    (tmp_path / "proc" / "stat").unlink()
    assert per_core(sampler) is None

    # recovered, with cpu0 having burned a full core over the interval
    (tmp_path / "proc" / "stat").write_text(
        proc_stat(100).replace(
            "cpu0 100 0 100 700 100", "cpu0 200 0 100 800 100"
        )
    )
    assert per_core(sampler) == [50.0, 0.0, 0.0, 0.0]


def test_per_core_stops_before_the_intr_line(tmp_path):
    # The read has to stop at the first non-cpu line, or every tick parses the
    # per-IRQ counters - the one unbounded read in a fixed-cost collector.
    # cpu9 sits *after* intr and would swing 0 -> 100% if it were ever reached,
    # so its staying at 0.0 is what proves the reader stopped.
    after_intr = "cpu9 100 0 100 700 100 0 0 0 0 0\n"
    sampler = make_sampler(
        tmp_path,
        cgroup_files=cpuset([0, 9]),
        proc_files={"stat": proc_stat(100) + after_intr},
    )
    per_core(sampler)
    (tmp_path / "proc" / "stat").write_text(
        proc_stat(100) + "cpu9 900 0 100 700 100 0 0 0 0 0\n"
    )
    assert per_core(sampler) == [0.0, 0.0]


def test_per_core_holds_position_when_a_core_disappears(tmp_path):
    # The cpuset and /proc/stat are read a moment apart, so a core offlined in
    # that window is still named by the core set but already gone from the
    # stats. It must read 0 rather than drop out, or the list comes back short
    # and every core after it shifts a cell to the left. (Once both reads see
    # the hotplug the set itself shrinks and the grid legitimately reshapes -
    # this pins the straddling tick, not the settled one.)
    sampler = make_sampler(
        tmp_path,
        cgroup_files=cpuset([0, 1, 2, 3]),
        proc_files={"stat": proc_stat(100)},
    )
    per_core(sampler)

    lines = [
        line
        for line in proc_stat(100).splitlines(keepends=True)
        if not line.startswith("cpu2 ")
    ]
    (tmp_path / "proc" / "stat").write_text("".join(lines))
    percents = per_core(sampler)
    assert len(percents) == 4
    assert percents[2] == 0.0


def test_the_cells_keep_core_order_however_the_cpuset_is_written(tmp_path):
    # Cell k covers a contiguous slice of this list, so the list's order IS the
    # core-to-cell map. The same cores spelled in another order must produce the
    # same list: a cpuset rewritten as "8,0-3" assigns nothing new, and if the
    # cores followed the spelling every one of them would jump to a different
    # cell under a user watching the grid.
    stat = proc_stat(100, extra="cpu8 100 0 100 800 100 0 0 0 0 0\n")
    busy = stat.replace("cpu8 100 0 100 800 100", "cpu8 200 0 100 900 100")

    def readings(spelling):
        sampler = make_sampler(
            tmp_path,
            cgroup_files=cpuset(spelling),
            proc_files={"stat": stat},
        )
        per_core(sampler)  # baseline
        (tmp_path / "proc" / "stat").write_text(busy)
        return per_core(sampler)

    # cpu8 is the only busy core and the highest id, so it belongs last in the
    # list - and so in the last bucket, wherever SPREAD then draws that bucket.
    # If the spelling wins it lands first instead, which is a different cell.
    assert readings([0, 1, 2, 3, 8]) == [0.0, 0.0, 0.0, 0.0, 50.0]
    assert readings([8, 0, 1, 2, 3]) == [0.0, 0.0, 0.0, 0.0, 50.0]


def test_per_core_is_none_under_a_quota_with_no_cpuset(tmp_path, monkeypatch):
    # --cpus=2 without --cpuset-cpus: the threads float across every host cpu,
    # so /proc/stat per-core figures are the machine's work, not this server's
    monkeypatch.setattr(os, "cpu_count", lambda: 4)
    sampler = make_sampler(
        tmp_path,
        cgroup_files={"cpu.stat": "usage_usec 0\n", "cpu.max": "200000 100000\n"},
        proc_files={"stat": proc_stat(100)},
    )
    assert per_core(sampler) is None


def test_per_core_is_none_when_a_quota_is_narrower_than_its_cpuset(tmp_path):
    # DEF-56: --cpus=2 --cpuset-cpus=0-3 (DockerSpawner pinning a NUMA node
    # while capping bandwidth). Four cores are named but only two can ever run
    # at once, so the cells would show four cores this server does not own and
    # a co-tenant saturating them would read as ours. The old gate keyed on
    # "cpuset absent" and drew the grid here, contradicting its own rule.
    sampler = make_sampler(
        tmp_path,
        cgroup_files={"cpu.max": "200000 100000\n", **cpuset([0, 1, 2, 3])},
        proc_files={"stat": proc_stat(100)},
    )
    assert per_core(sampler) is None


def test_per_core_survives_a_quota_that_covers_its_cpuset(tmp_path):
    # --cpus=2 --cpuset-cpus=0-1, or k8s cpuManagerPolicy: static - the quota
    # buys exactly the cores named, so they are genuinely this server's
    sampler = make_sampler(
        tmp_path,
        cgroup_files={"cpu.max": "200000 100000\n", **cpuset([0, 1])},
        proc_files={"stat": proc_stat(100)},
    )
    assert per_core(sampler) == [0.0, 0.0]


def test_a_quota_wider_than_its_cpuset_does_not_widen_the_denominator(tmp_path):
    # DEF-58: the ceiling was the raw quota while the cells came from the
    # cpuset, so `CPUQuota=400%` with `AllowedCPUs=0-1` divided by 4 and drew
    # 2 cells - both cores saturated reading 50% under "of 4 CPUs". A quota
    # buys no more than the cores can deliver. The suite tested this boundary
    # at `<` and at `==` and never above it, which is how it survived.
    sampler = make_sampler(
        tmp_path,
        cgroup_files={"cpu.max": "400000 100000\n", **cpuset([0, 1])},
        proc_files={"stat": proc_stat(100)},
    )
    capacity, ids = sampler._cpu_scope()
    assert capacity == 2
    assert len(ids) == 2
    assert len(per_core(sampler)) == capacity


@pytest.mark.parametrize(
    "quota, expected_cells",
    [("100000 100000", None), ("200000 100000", 2), ("800000 100000", 2)],
)
def test_the_cells_always_cover_the_denominator(tmp_path, quota, expected_cells):
    # The invariant in one assertion, swept across the quota boundary: below
    # the core count there is nothing to draw, at or above it the cells are
    # the denominator. DEF-55 and DEF-58 were both this pair disagreeing.
    sampler = make_sampler(
        tmp_path,
        cgroup_files={"cpu.max": quota + "\n", **cpuset([0, 1])},
        proc_files={"stat": proc_stat(100)},
    )
    capacity, _ids = sampler._cpu_scope()
    cells = per_core(sampler)
    assert (len(cells) if cells is not None else None) == expected_cells
    if cells is not None:
        assert len(cells) == capacity


def test_entering_the_gated_regime_drops_the_baseline(tmp_path):
    # `docker update --cpus` in and back out. The baseline has to be gathered
    # BEFORE the gate for this to bite - entering with an empty one makes the
    # clear a no-op and the test blind, which is how the first version of it
    # let the mutation through.
    quota = tmp_path / "cgroup" / "cpu.max"
    sampler = make_sampler(
        tmp_path,
        cgroup_files={"cpu.max": "max 100000\n", **cpuset([0, 1, 2, 3])},
        proc_files={"stat": proc_stat(100)},
    )
    assert per_core(sampler) == [0.0, 0.0, 0.0, 0.0]  # baseline now exists

    quota.write_text("200000 100000\n")  # 2 CPUs over 4 cores: gated
    assert per_core(sampler) is None

    # the quota is lifted again, and cpu0 burned a full core in the meantime
    quota.write_text("max 100000\n")
    (tmp_path / "proc" / "stat").write_text(
        proc_stat(100).replace("cpu0 100 0 100 700 100", "cpu0 200 0 100 800 100")
    )
    # 0.0 rather than 50.0: nothing survived the gate, so this is a first
    # sample. Keeping the stale baseline would report the average across the
    # whole time the bar was on screen as though it were the current tick.
    assert per_core(sampler) == [0.0, 0.0, 0.0, 0.0]


def test_cpu_count_follows_the_cgroup_cpuset(tmp_path, monkeypatch):
    # DEF-52: os.cpu_count() counts every cpu on the machine, so a container
    # confined by --cpuset-cpus divided its own usage by the host's core count
    # and reported a saturated server at a fraction of its real load
    monkeypatch.setattr(os, "cpu_count", lambda: 64)
    sampler = make_sampler(
        tmp_path, cgroup_files={"cpuset.cpus.effective": "0-3\n"}
    )
    assert sampler._cpu_scope()[0] == 4


def test_nothing_consults_this_task_s_affinity_mask(tmp_path, monkeypatch):
    # DEF-53 and DEF-55, pinned together because they are one mistake. cpu.stat
    # counts every process in the cgroup, so the population is the cgroup's
    # cpuset - never this task's affinity mask, which narrows one process.
    # Taking affinity for the denominator divided a cgroup-wide numerator by 4
    # under `taskset -c 0-3` and pinned an idle 64-core host at 100%; taking it
    # for the core set drew a 4-core grid beside a tooltip reading "of 64
    # CPUs". One hover, two populations. Under taskset both must stay at 8.
    monkeypatch.setattr(os, "cpu_count", lambda: 8)
    monkeypatch.setattr(
        os, "sched_getaffinity", lambda pid: {0, 1, 2, 3}, raising=False
    )
    sampler = make_sampler(
        tmp_path,
        cgroup_files=cpuset(range(8)),
        proc_files={"stat": proc_stat(100)},
    )
    assert sampler._cpu_scope()[0] == 8
    assert len(per_core(sampler)) == 8


def test_cpu_count_parses_a_disjoint_cpuset(tmp_path, monkeypatch):
    monkeypatch.setattr(os, "cpu_count", lambda: 64)
    sampler = make_sampler(
        tmp_path, cgroup_files={"cpuset.cpus.effective": "0-3,8,12-15\n"}
    )
    assert sampler._cpu_scope()[0] == 9


def test_proc_fallback_denominator_is_the_whole_machine(tmp_path, monkeypatch):
    # /proc/stat's aggregate line already counted every CPU, so narrowing the
    # denominator to this task's cores inflates the quotient
    monkeypatch.setattr(os, "cpu_count", lambda: 64)
    sampler = make_sampler(
        tmp_path, proc_files={"stat": "cpu  100 0 100 700 100 0 0 0 0 0\n"}
    )
    assert sampler._read_cpu()[1] == 64


def test_the_proc_fallback_moves_the_cells_with_the_denominator(tmp_path, monkeypatch):
    # `_cpu_scope` makes the pair inexpressible apart, but the /proc branch
    # re-derives it by hand - the one place the invariant is maintained rather
    # than structural, and so the one place it can silently rot. A narrowed
    # cpuset with no readable cpu.stat would otherwise publish the cgroup's 2
    # cells beside the machine's count of 4: DEF-58 through the other branch.
    monkeypatch.setattr(os, "cpu_count", lambda: 4)
    sampler = make_sampler(
        tmp_path,
        cgroup_files={"cpuset.cpus.effective": "0-1\n"},  # no cpu.stat
        proc_files={"stat": proc_stat(100)},
    )
    _percent, cpu_count, ids = sampler._read_cpu()
    assert cpu_count == 4
    assert len(ids) == cpu_count
    assert len(per_core(sampler)) == cpu_count


def test_quota_still_outranks_the_cpuset(tmp_path):
    # a bandwidth quota is tighter than the cores it may run on
    sampler = make_sampler(
        tmp_path,
        cgroup_files={"cpu.max": "200000 100000\n", **cpuset([0, 1, 2, 3])},
    )
    assert sampler._cpu_scope()[0] == 2


def test_snapshot_carries_per_core(tmp_path):
    sampler = make_sampler(
        tmp_path,
        cgroup_files=cpuset([0, 1, 2, 3]),
        proc_files={"stat": proc_stat(100), "meminfo": MEMINFO},
    )
    sampler.sample_once()
    assert sampler.snapshot()["cpu"]["per_core"] == [0.0, 0.0, 0.0, 0.0]
