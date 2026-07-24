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


def test_cgroup_cpu_first_sample_is_zero(tmp_path):
    sampler = make_sampler(
        tmp_path,
        cgroup_files={
            "cpu.stat": "usage_usec 1000000\n",
            "cpu.max": "200000 100000\n",
        },
    )
    percent, cpu_count = sampler._read_cpu()
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
    monkeypatch.setattr(time, "monotonic", lambda: 100.0)
    sampler._read_cpu()
    # one second later, one full CPU of the two was busy -> 50%
    (tmp_path / "cgroup" / "cpu.stat").write_text("usage_usec 2000000\n")
    monkeypatch.setattr(time, "monotonic", lambda: 101.0)
    percent, cpu_count = sampler._read_cpu()
    assert cpu_count == 2
    assert percent == 50.0


def test_proc_cpu_fallback_delta(tmp_path):
    sampler = make_sampler(
        tmp_path,
        proc_files={"stat": "cpu  100 0 100 700 100 0 0 0 0 0\n"},
    )
    percent, _count = sampler._read_cpu()
    assert percent == 0.0
    # busy delta 100, total delta 200 -> 50%
    (tmp_path / "proc" / "stat").write_text("cpu  200 0 100 800 100 0 0 0 0 0\n")
    percent, _count = sampler._read_cpu()
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
    percent, _count = sampler._read_cpu()
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
    # must not raise; effective cpu count falls back to os.cpu_count()
    import os

    assert sampler._effective_cpu_count() == (os.cpu_count() or 1)


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
