# jupyterlab_resource_monitor_extension

[![GitHub Actions](https://github.com/stellarshenson/jupyterlab_resource_monitor_extension/actions/workflows/build.yml/badge.svg)](https://github.com/stellarshenson/jupyterlab_resource_monitor_extension/actions/workflows/build.yml)
[![npm version](https://img.shields.io/npm/v/jupyterlab_resource_monitor_extension.svg)](https://www.npmjs.com/package/jupyterlab_resource_monitor_extension)
[![PyPI version](https://img.shields.io/pypi/v/jupyterlab-resource-monitor-extension.svg)](https://pypi.org/project/jupyterlab-resource-monitor-extension/)
[![Total PyPI downloads](https://static.pepy.tech/badge/jupyterlab-resource-monitor-extension)](https://pepy.tech/project/jupyterlab-resource-monitor-extension)
[![JupyterLab 4](https://img.shields.io/badge/JupyterLab-4-orange.svg)](https://jupyterlab.readthedocs.io/en/stable/)
[![Brought To You By KOLOMOLO](https://img.shields.io/badge/Brought%20To%20You%20By-KOLOMOLO-00ffff?style=flat)](https://kolomolo.com)
[![Donate PayPal](https://img.shields.io/badge/Donate-PayPal-blue?style=flat)](https://www.paypal.com/donate/?hosted_button_id=B4KPBJDLLXTSA)

JupyterLab extension that replaces `jupyter-resource-usage` with a less intrusive and better implementation of resource usage monitoring.

This extension is composed of a Python package named `jupyterlab_resource_monitor_extension`
for the server extension and a NPM package named `jupyterlab_resource_monitor_extension`
for the frontend extension.

## Features

- **Memory monitor in the status bar** - current memory usage with the maximum available memory shown alongside; under cgroup v2 this is the server's own cgroup, and without it the reading is host-wide
- **CPU usage in the status bar** - live CPU utilization next to the memory indicator, as a percentage or a compact bar; same scope as the memory reading
- **Kernel usage panel** - sidebar panel showing memory and CPU for the kernel attached to the notebook you are looking at
- **Container aware** - reads the cgroup v2 limits when present, so the ceiling shown is the container's limit rather than the host's RAM
- **Event-loop safe metrics collection** - metrics are gathered off the tornado event loop, so polling never blocks websockets, kernel messages, or static file serving
- **Bounded collection cost** - no synchronous recursive walk of the server's child process tree, so a large or leaked process population cannot degrade JupyterLab responsiveness
- **Measures kernels only while you are watching** - the kernel panel samples solely while it is open, and stops entirely when it is closed
- **Drop-in replacement** - designed to replace `jupyter-resource-usage` with a safer implementation

How the collection stays off the event loop, what bounds its cost, and how it degrades is described in [How Resource Collection Avoids Blocking the Server](https://github.com/stellarshenson/jupyterlab_resource_monitor_extension/blob/main/docs/collection-design.md).

## Settings

Configure under Settings -> Settings Editor -> Resource Monitor.

| Setting             | Default      | Effect                                                                                                  |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| `showMemory`        | `true`       | Show the memory item in the status bar                                                                  |
| `showCpu`           | `true`       | Show the CPU item in the status bar                                                                     |
| `showMemoryPercent` | `false`      | Append the used-of-limit percentage to the memory item                                                  |
| `cpuMode`           | `normalised` | `normalised` shares all cores (0-100%), `aggregate` sums each core's own 100%, `bar` draws a filled bar |
| `showKernelUsage`   | `true`       | Show the kernel usage sidebar panel                                                                     |

Hovering either status bar item shows the full detail regardless of these settings, including the memory percentage and the CPU core count.

## Requirements

- JupyterLab >= 4.0.0
- Linux host - the sampler reads cgroup v2 and `/proc`; on macOS and Windows no reading is available, so the status bar items stay hidden and the kernel panel reports `Measuring...`

## Install

To install the extension, execute:

```bash
pip install jupyterlab_resource_monitor_extension
```

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyterlab_resource_monitor_extension
```
