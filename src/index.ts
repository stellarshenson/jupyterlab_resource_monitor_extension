import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { IStatusBar } from '@jupyterlab/statusbar';

import { Poll } from '@lumino/polling';

import { Widget } from '@lumino/widgets';

import {
  cpuSegments,
  cpuTooltip,
  ISegment,
  MemLevel,
  memoryLevel,
  memorySegments,
  memoryTooltip
} from './format';

import { requestAPI } from './request';

/**
 * Snapshot shape returned by the server extension's metrics endpoint.
 */
interface IMetricsSnapshot {
  mem: { used_bytes: number; total_bytes: number; limit_source: string };
  cpu: { percent: number; cpu_count: number };
  ts: number;
}

/**
 * Poll interval for the metrics endpoint in milliseconds.
 */
const POLL_INTERVAL = 5000;

/**
 * Ceiling the backoff may raise the interval to while the endpoint is failing,
 * so a dead server is retried once a minute rather than never.
 */
const MAX_POLL_INTERVAL = 60000;

/**
 * Consecutive failed polls tolerated before the items are hidden, so a single
 * transient hiccup (laptop wake, proxy blip) does not read as a crash.
 */
const HIDE_AFTER_FAILURES = 3;

/**
 * Consecutive polls with an unchanged timestamp before the snapshot is treated
 * as stale - the sampler thread has stopped producing samples.
 */
const STALE_AFTER_POLLS = 3;

/**
 * A status bar item that renders its changing numbers in fixed-width columns
 * and carries a memory-pressure level.
 */
class ResourceItem extends Widget {
  constructor(kind: string) {
    super();
    this.addClass('jp-ResourceMonitor-item');
    this.addClass(`jp-ResourceMonitor-${kind}`);
    // role="img" makes the aria-label the element's accessible name; without a
    // role, screen readers may ignore aria-label on a generic div.
    this.node.setAttribute('role', 'img');
    // The segments live inside one inline wrapper: as direct children of the
    // flex item, the whitespace-only runs between them would not be rendered.
    this._content = document.createElement('span');
    this.node.appendChild(this._content);
    this.hide();
  }

  set segments(values: ISegment[]) {
    this._content.textContent = '';
    for (const segment of values) {
      if (segment.columns === undefined) {
        this._content.appendChild(document.createTextNode(segment.text));
        continue;
      }
      const column = document.createElement('span');
      column.className = 'jp-ResourceMonitor-column';
      column.style.width = `${segment.columns}ch`;
      column.textContent = segment.text;
      this._content.appendChild(column);
    }
  }

  set tooltip(value: string) {
    // title serves mouse hover; with role="img" the aria-label is the element's
    // accessible name, so screen-reader and touch-explore users reach the same
    // detail (the item is not in the tab order, so keyboard focus does not).
    this.node.title = value;
    this.node.setAttribute('aria-label', value);
  }

  set level(value: MemLevel) {
    this.toggleClass('jp-ResourceMonitor-warn', value === 'warn');
    this.toggleClass('jp-ResourceMonitor-danger', value === 'danger');
  }

  private _content: HTMLElement;
}

/**
 * Initialization data for the jupyterlab_resource_monitor_extension extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_resource_monitor_extension:plugin',
  description:
    'Jupyterlab extension to replace jupyter-resource-usage with less intrusive and better implementation for resource usage',
  autoStart: true,
  optional: [IStatusBar],
  activate: (app: JupyterFrontEnd, statusBar: IStatusBar | null) => {
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
    let lastTs = -1;
    let staleCount = 0;

    statusBar.registerStatusItem(
      'jupyterlab_resource_monitor_extension:memory',
      { item: memoryItem, align: 'left', rank: 2 }
    );
    statusBar.registerStatusItem('jupyterlab_resource_monitor_extension:cpu', {
      item: cpuItem,
      align: 'left',
      rank: 3
    });

    const hideItems = (): void => {
      memoryItem.hide();
      cpuItem.hide();
    };

    const render = (snap: IMetricsSnapshot): void => {
      const { used_bytes: used, total_bytes: total } = snap.mem;
      const frac = total > 0 ? used / total : 0;
      memLevel = memoryLevel(frac, memLevel);
      const percent = frac * 100;
      // The percentage is always shown - it is the glanceable "how close to the
      // ceiling" signal and its constant presence stops the row reflowing when
      // the level changes.
      memoryItem.segments = memorySegments(used, total, percent);
      memoryItem.level = memLevel;
      memoryItem.tooltip = memoryTooltip(
        used,
        total,
        percent,
        snap.mem.limit_source,
        memLevel
      );

      cpuItem.segments = cpuSegments(snap.cpu.percent);
      cpuItem.tooltip = cpuTooltip(snap.cpu.percent, snap.cpu.cpu_count);

      memoryItem.show();
      cpuItem.show();
    };

    const update = async (): Promise<void> => {
      let snap: IMetricsSnapshot;
      try {
        snap = await requestAPI<IMetricsSnapshot>(
          'metrics',
          app.serviceManager.serverSettings
        );
      } catch (reason) {
        if (++failures >= HIDE_AFTER_FAILURES) {
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
      if (snap.ts === lastTs) {
        staleCount += 1;
      } else {
        staleCount = 0;
        lastTs = snap.ts;
      }
      if (staleCount >= STALE_AFTER_POLLS || snap.mem.total_bytes <= 0) {
        hideItems();
        return;
      }

      render(snap);
    };

    void new Poll({
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
  }
};

export default plugin;
