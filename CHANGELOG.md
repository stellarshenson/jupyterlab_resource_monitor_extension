# Changelog

<!-- <START NEW CHANGELOG ENTRY> -->

## [1.0.25] - 2026-07-25

Release-tooling only. No functional change to the extension.

### Changed

- `make test` now runs the Python suite alongside the frontend one, so a server-side regression is caught locally rather than only in CI
- `make publish` is the sole release path; the `prep-release` and `publish-release` workflows are removed because they own the version and the upload just as the Makefile does, and two live mechanisms can disagree on the next version
- `check-release.yml` is retained - it validates that the package is releasable and never publishes

<!-- <END NEW CHANGELOG ENTRY> -->

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
