import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { IStatusBar } from '@jupyterlab/statusbar';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { INotebookTracker } from '@jupyterlab/notebook';

import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { Poll } from '@lumino/polling';

import {
  CpuMode,
  cpuFraction,
  cpuTooltip,
  formatCpuText,
  formatMemoryText,
  MemLevel,
  memoryLevel,
  memoryTooltip
} from './format';

import { ResourceItem } from './item';

import { KernelUsagePanel } from './kernelpanel';

import { requestAPI } from './request';

import {
  initialPollState,
  MAX_POLL_INTERVAL,
  POLL_INTERVAL,
  resolveDisplaySettings,
  shouldHideOnFailure,
  trackSnapshot
} from './state';

/**
 * Snapshot shape returned by the server extension's metrics endpoint.
 */
interface IMetricsSnapshot {
  mem: { used_bytes: number; total_bytes: number; limit_source: string };
  cpu: { percent: number; cpu_count: number };
  ts: number;
}

/**
 * The settings-carrying plugin id. Both plugins read this one schema, so it is
 * named once rather than reached for through the other plugin object.
 */
const PLUGIN_ID = 'jupyterlab_resource_monitor_extension:plugin';

/**
 * Initialization data for the jupyterlab_resource_monitor_extension extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'JupyterLab extension replacing jupyter-resource-usage with a less intrusive, better implementation of resource usage monitoring',
  autoStart: true,
  optional: [IStatusBar, ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    statusBar: IStatusBar | null,
    settingRegistry: ISettingRegistry | null
  ) => {
    console.log(
      'JupyterLab extension jupyterlab_resource_monitor_extension is activated!'
    );

    if (!statusBar) {
      return;
    }

    const memoryItem = new ResourceItem('memory');
    const cpuItem = new ResourceItem('cpu');

    let memLevel: MemLevel = 'normal';
    let failures = 0;
    let warned = false;
    let pollState = initialPollState();
    // Latest good sample, kept so a settings change can re-render without
    // waiting for the next poll; cleared whenever the items are hidden so a
    // toggle never re-shows stale data.
    let lastSnap: IMetricsSnapshot | null = null;

    // Display settings. The items default on so they still show if the setting
    // registry is absent or its load fails; the percentage defaults off.
    let showMemory = true;
    let showCpu = true;
    let showMemoryPercent = false;
    let cpuMode: CpuMode = 'normalised';

    // The status bar owns widget visibility - it re-decides it from isActive()
    // at registration and on every layout change - so the items expose their
    // own `active` flag and a signal to re-ask, rather than calling
    // show()/hide(), which the next tab open would silently undo.
    statusBar.registerStatusItem(
      'jupyterlab_resource_monitor_extension:memory',
      {
        item: memoryItem,
        align: 'left',
        rank: 2,
        isActive: () => memoryItem.active,
        activeStateChanged: memoryItem.activeChanged
      }
    );
    statusBar.registerStatusItem('jupyterlab_resource_monitor_extension:cpu', {
      item: cpuItem,
      align: 'left',
      rank: 3,
      isActive: () => cpuItem.active,
      activeStateChanged: cpuItem.activeChanged
    });

    const hideItems = (): void => {
      lastSnap = null;
      memoryItem.active = false;
      cpuItem.active = false;
    };

    const render = (snap: IMetricsSnapshot): void => {
      lastSnap = snap;
      const { used_bytes: used, total_bytes: total } = snap.mem;
      const frac = total > 0 ? used / total : 0;
      memLevel = memoryLevel(frac, memLevel);
      const percent = frac * 100;

      if (showMemory) {
        memoryItem.text = formatMemoryText(
          used,
          total,
          showMemoryPercent ? percent : null
        );
        memoryItem.level = memLevel;
        memoryItem.tooltip = memoryTooltip(
          used,
          total,
          percent,
          snap.mem.limit_source,
          memLevel
        );
        memoryItem.active = true;
      } else {
        memoryItem.active = false;
      }

      if (showCpu) {
        if (cpuMode === 'bar') {
          // no trailing space: the item is a flex container, which trims it -
          // the gap before the bar comes from the bar's own margin
          cpuItem.setBar('CPU:', cpuFraction(snap.cpu.percent));
        } else {
          cpuItem.text = formatCpuText(
            snap.cpu.percent,
            cpuMode,
            snap.cpu.cpu_count
          );
        }
        cpuItem.tooltip = cpuTooltip(snap.cpu.percent, snap.cpu.cpu_count);
        cpuItem.active = true;
      } else {
        cpuItem.active = false;
      }
    };

    const applySettings = (settings: ISettingRegistry.ISettings): void => {
      const resolved = resolveDisplaySettings(
        key => settings.get(key).composite
      );
      showMemory = resolved.showMemory;
      showCpu = resolved.showCpu;
      showMemoryPercent = resolved.showMemoryPercent;
      if (resolved.cpuMode !== cpuMode) {
        // leaving bar mode must clear the bar DOM, and entering it must rebuild
        // it, so reset the item to plain text and let render rebuild
        cpuMode = resolved.cpuMode;
        cpuItem.text = '';
      }
      // Re-render from the last good sample so a toggle takes effect at once,
      // rather than on the next poll up to POLL_INTERVAL later.
      if (lastSnap) {
        render(lastSnap);
      }
    };

    if (settingRegistry) {
      settingRegistry
        .load(PLUGIN_ID)
        .then(settings => {
          applySettings(settings);
          settings.changed.connect(applySettings);
        })
        .catch(reason => {
          console.warn(
            'jupyterlab_resource_monitor_extension: could not load settings, showing all items',
            reason
          );
        });
    }

    const update = async (): Promise<void> => {
      let snap: IMetricsSnapshot;
      try {
        snap = await requestAPI<IMetricsSnapshot>(
          'metrics',
          app.serviceManager.serverSettings
        );
      } catch (reason) {
        if (shouldHideOnFailure(++failures)) {
          hideItems();
        }
        if (!warned) {
          warned = true;
          console.warn(
            'jupyterlab_resource_monitor_extension: metrics endpoint unavailable',
            reason
          );
        }
        throw reason; // let Poll back off while the endpoint is unavailable
      }

      failures = 0;

      // The sampler stamps a fresh ts every sample; an unchanged ts across
      // several polls means it has stopped - do not present frozen numbers as
      // live. Missing data (total <= 0, e.g. no /proc) is likewise not shown.
      const next = trackSnapshot(snap.ts, snap.mem.total_bytes, pollState);
      pollState = { lastTs: next.lastTs, staleCount: next.staleCount };
      if (next.hide) {
        hideItems();
        return;
      }

      render(snap);
    };

    const poll = new Poll({
      auto: true,
      factory: update,
      frequency: {
        interval: POLL_INTERVAL,
        backoff: true,
        max: MAX_POLL_INTERVAL
      },
      standby: 'when-hidden',
      name: 'jupyterlab_resource_monitor_extension:metrics'
    });
    // The poll outlives activation, so hold the handle rather than discarding
    // it. The status bar disposes both items through the disposables it
    // returned from registerStatusItem, so the only thing left to tear down
    // here is the poll that feeds them.
    memoryItem.disposed.connect(() => {
      poll.dispose();
    });
  }
};

/**
 * Kernel usage sidebar panel, showing the current notebook's kernel.
 *
 * Separate from the status bar plugin because it depends on the notebook
 * tracker: without notebooks the status bar still works, and this plugin
 * simply never activates.
 */
const kernelUsagePlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_resource_monitor_extension:kernel-usage',
  description: "Sidebar panel showing the current notebook kernel's usage",
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ISettingRegistry, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    settingRegistry: ISettingRegistry | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load(
      'jupyterlab_resource_monitor_extension'
    );
    let panel: KernelUsagePanel | null = null;

    const show = (): void => {
      if (panel) {
        return;
      }
      panel = new KernelUsagePanel({
        tracker,
        serverSettings: app.serviceManager.serverSettings,
        trans
      });
      // right sidebar, matching where jupyter-resource-usage put its panel
      app.shell.add(panel, 'right', { rank: 200 });
    };

    const hide = (): void => {
      panel?.dispose();
      panel = null;
    };

    const apply = (settings: ISettingRegistry.ISettings): void => {
      if (
        resolveDisplaySettings(key => settings.get(key).composite)
          .showKernelUsage
      ) {
        show();
      } else {
        hide();
      }
    };

    if (!settingRegistry) {
      show();
      return;
    }

    settingRegistry
      .load(PLUGIN_ID)
      .then(settings => {
        apply(settings);
        settings.changed.connect(apply);
      })
      .catch(reason => {
        console.warn(
          'jupyterlab_resource_monitor_extension: could not load settings, showing the kernel panel',
          reason
        );
        show();
      });
  }
};

export default [plugin, kernelUsagePlugin];
