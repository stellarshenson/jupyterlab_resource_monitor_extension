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

- **Memory monitor in the status bar** - current server memory usage with the maximum available memory shown alongside
- **CPU usage in the status bar** - live CPU utilization next to the memory indicator
- **Event-loop safe metrics collection** - metrics are gathered off the tornado event loop, so polling never blocks websockets, kernel messages, or static file serving
- **Bounded collection cost** - no synchronous recursive walk of the server's child process tree, so a large or leaked process population cannot degrade JupyterLab responsiveness
- **Drop-in replacement** - designed to replace `jupyter-resource-usage` with a safer implementation

## Requirements

- JupyterLab >= 4.0.0

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
