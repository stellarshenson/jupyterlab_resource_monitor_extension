# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [1.0.30] - 2026-07-27

Test hardening only. No functional change to the extension.

### Changed

- Three guards over the `grid` mode could not fail under the mutations they exist to catch: the hot cell's colour was pinned only as different from a cool one, so repainting the burn in the warn palette passed; the "CPU never wears the memory item's warn or danger styling" assertion ran against a snapshot where no item could be under pressure; and every geometry assertion ran at 4x4, the one grid edge that divides into whole pixels regardless of the cell cap. All three now fail under those mutations, and a 3x3 case covers the middle edge

<!-- <END NEW CHANGELOG ENTRY> -->

## [1.0.29] - 2026-07-27

### Fixed

- The `grid` CPU display mode drew its cells with a 1px gap between them, so the status bar background showed through and a machine with every core busy rendered a lattice rather than the solid square the mode exists to show. The cells now tile the square edge to edge, and the box grows from 13px to 14px so the 12px left to the cells still divides exactly at every size the grid draws: 6px cells at 2x2, 4px at 3x3, 3px at 4x4

## [1.0.27] - 2026-07-26

### Added

- `grid` CPU display mode: a square of cells showing the load on each core assigned to this server, so a few pinned cores and an evenly busy machine are distinguishable at the same aggregate percentage. Cells gain opacity with load and burn brighter past 75%; where a CPU quota is narrower than the cores it runs on, the allowance is a slice of time rather than a set of cores and the item falls back to the bar
- `per_core` in the metrics payload: one percentage per assigned core, read from the `cpuN` lines of `/proc/stat`, or `null` where the cores are not the real ceiling

### Fixed

- CPU percentages were divided by the host's total core count whenever no cgroup quota applied, because `os.cpu_count()` ignores CPU confinement; a container pinned to four cores of a 64-core host reported a saturated server at about 6%. The count now comes from the cgroup's own `cpuset.cpus.effective`, which is the population `cpu.stat` measures, with a quota still taking precedence
- A CPU quota wider than the cores it may run on widened the denominator past them, so a container given `CPUQuota=400%` on two cores reported 50% while both were saturated. The ceiling and the core set are now resolved as one value and cannot disagree
- An unreadable or non-UTF-8 `/proc/stat` aborted the whole sample rather than only the CPU part of it, so the status bar hid the memory reading too
- The status bar's fixed-size grid and bar compressed along one axis on a crowded status bar, rendering the square grid as a rectangle

## [1.0.25] - 2026-07-25

Release-tooling only. No functional change to the extension.

### Changed

- `make test` now runs the Python suite alongside the frontend one, so a server-side regression is caught locally rather than only in CI
- `make publish` is the sole release path; the `prep-release` and `publish-release` workflows are removed because they own the version and the upload just as the Makefile does, and two live mechanisms can disagree on the next version
- `check-release.yml` is retained - it validates that the package is releasable and never publishes

## [1.0.24] - 2026-07-25

First published release. Replaces `jupyter-resource-usage` with an implementation that never collects metrics on the tornado event loop.

### Added

- Memory usage in the status bar, showing current use against the maximum available
- CPU usage in the status bar, with `normalised` (share of all cores), `aggregate` (top-style sum) and `bar` display modes
- Kernel usage sidebar panel reporting memory and CPU for the kernel attached to the notebook currently in view
- Container-aware limits read from cgroup v2 (`memory.max`, `cpu.max`), falling back to `/proc/meminfo` and `os.cpu_count()`
- Settings for `showMemory`, `showCpu`, `showMemoryPercent`, `cpuMode` and `showKernelUsage`, applied without a reload
- `GET /jupyterlab-resource-monitor-extension/metrics` and `GET .../kernels?kernel_id=<id>` returning cached snapshots

### Changed

- Server metrics are collected on a background thread from a fixed set of files, so cost does not scale with the server's child process count and no request handler ever walks `/proc`
- The kernel panel measures only while it is open: each poll renews a 15s lease on the server, and a closed panel lets the lease lapse so no process tree is walked
- Status bar text renders flush, without reserved-width padding
- The memory percentage is hidden inline by default; the tooltip always carries the full detail
- The kernel process walk is bounded by a file-read budget rather than a process count, and enumerates threads with `os.scandir` so the budget stops the enumeration itself instead of only the reads
- Status bar item visibility is delegated to `IStatusBar` through `isActive`/`activeStateChanged`, so a tab open no longer undoes it
