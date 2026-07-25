import { ServerConnection } from '@jupyterlab/services';

import { INotebookTracker } from '@jupyterlab/notebook';

import { TranslationBundle } from '@jupyterlab/translation';

import { Poll } from '@lumino/polling';

import { Widget } from '@lumino/widgets';

import { formatBytes } from './format';

import { tachometerIcon } from './icon';

import { requestAPI } from './request';

import {
  initialPollState,
  IPollState,
  kernelPanelState,
  MAX_POLL_INTERVAL,
  POLL_INTERVAL,
  shouldHideOnFailure
} from './state';

/**
 * Sample for the one watched kernel, or `null` when the server has nothing for
 * the asked kernel (unknown id, remote kernel, or no sample taken yet).
 */
interface IKernelSnapshot {
  kernel: {
    id: string;
    name: string;
    memory_bytes: number;
    cpu_percent: number;
  } | null;
  ts: number;
}

/**
 * Sidebar panel showing resource usage for the kernel attached to the notebook
 * currently in view - the same scope and mark as the panel `jupyter-resource-
 * usage` provided.
 *
 * The panel polls only while it is visible: the server samples a kernel solely
 * on the strength of these polls, so a closed or collapsed panel means no
 * process-tree walking happens at all.
 */
export class KernelUsagePanel extends Widget {
  constructor(options: {
    tracker: INotebookTracker;
    serverSettings: ServerConnection.ISettings;
    trans: TranslationBundle;
  }) {
    super();
    this._tracker = options.tracker;
    this._serverSettings = options.serverSettings;
    this._trans = options.trans;

    this.id = 'jupyterlab-resource-monitor-extension-kernel-usage';
    this.title.icon = tachometerIcon;
    this.title.caption = this._trans.__('Kernel Usage');
    this.addClass('jp-ResourceMonitor-panel');

    const heading = document.createElement('h2');
    heading.className = 'jp-ResourceMonitor-panelHeading';
    heading.textContent = this._trans.__('Kernel Usage');
    this.node.appendChild(heading);

    this._body = document.createElement('div');
    this.node.appendChild(this._body);
    this._renderEmpty(this._trans.__('No kernel'));

    this._poll = new Poll({
      auto: true,
      factory: () => this._update(),
      frequency: {
        interval: POLL_INTERVAL,
        backoff: true,
        max: MAX_POLL_INTERVAL
      },
      // The whole point of the lease on the server: no polls while the panel is
      // out of view means no sampling.
      standby: () => !this.isVisible,
      name: 'jupyterlab_resource_monitor_extension:kernels'
    });

    // Re-render at once when the user switches notebooks, rather than leaving
    // the previous kernel's numbers up until the next poll lands. Connected
    // after the poll exists, and with `this` as the receiver so disposing the
    // panel takes the connection with it - otherwise a later notebook switch
    // would refresh a disposed poll.
    this._tracker.currentChanged.connect(this._onNotebookChanged, this);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._tracker.currentChanged.disconnect(this._onNotebookChanged, this);
    this._poll.dispose();
    super.dispose();
  }

  private _onNotebookChanged(): void {
    this._renderEmpty(this._trans.__('No kernel'));
    void this._poll.refresh();
  }

  /**
   * The kernel id of the notebook currently in view, if it has one.
   */
  private _currentKernelId(): string | null {
    const sessionContext = this._tracker.currentWidget?.sessionContext;
    return sessionContext?.session?.kernel?.id ?? null;
  }

  private async _update(): Promise<void> {
    const kernelId = this._currentKernelId();
    if (!kernelId) {
      this._renderEmpty(this._trans.__('No kernel'));
      return;
    }

    let snap: IKernelSnapshot;
    try {
      snap = await requestAPI<IKernelSnapshot>(
        `kernels?kernel_id=${encodeURIComponent(kernelId)}`,
        this._serverSettings
      );
    } catch (reason) {
      if (!this._warned) {
        this._warned = true;
        console.warn(
          'jupyterlab_resource_monitor_extension: kernel metrics unavailable',
          reason
        );
      }
      // A single blip is not a crash: the panel keeps its last reading until
      // the failures persist, matching the status bar's tolerance.
      if (shouldHideOnFailure(++this._failures)) {
        this._renderEmpty(this._trans.__('Unavailable'));
      }
      throw reason; // let Poll back off while the endpoint is unavailable
    }

    this._failures = 0;
    const next = kernelPanelState({
      kernel: snap.kernel,
      ts: snap.ts,
      prev: this._pollState
    });
    this._pollState = { lastTs: next.lastTs, staleCount: next.staleCount };

    if (next.state !== 'reading' || !snap.kernel) {
      this._renderEmpty(this._trans.__('Measuring...'));
      return;
    }

    this._renderKernel(snap.kernel);
  }

  private _renderEmpty(message: string): void {
    this._body.textContent = '';
    const empty = document.createElement('p');
    empty.className = 'jp-ResourceMonitor-panelEmpty';
    empty.textContent = message;
    this._body.appendChild(empty);
  }

  private _renderKernel(kernel: {
    name: string;
    memory_bytes: number;
    cpu_percent: number;
  }): void {
    this._body.textContent = '';
    this._body.appendChild(
      this._row(
        this._trans.__('Kernel'),
        kernel.name || this._trans.__('unknown')
      )
    );
    this._body.appendChild(
      this._row(this._trans.__('Memory'), formatBytes(kernel.memory_bytes))
    );
    this._body.appendChild(
      this._row(
        this._trans.__('CPU'),
        `${Math.round(kernel.cpu_percent)}%`,
        // This percentage is not the status bar's: that one is normalised over
        // every core, this is a share of ONE core, so a multi-threaded kernel
        // legitimately exceeds 100%. Say so rather than let the two readings
        // look like they disagree.
        this._trans.__(
          'Share of one CPU core - a multi-threaded kernel can exceed 100%'
        )
      )
    );
  }

  private _row(label: string, value: string, tooltip?: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'jp-ResourceMonitor-panelRow';
    if (tooltip) {
      row.title = tooltip;
      // role="img" for the same reason the status bar item carries one: a bare
      // div's aria-label is not reliably announced, so the explanation would
      // reach mouse users only
      row.setAttribute('role', 'img');
      row.setAttribute('aria-label', `${label}: ${value}. ${tooltip}`);
    }

    const key = document.createElement('span');
    key.className = 'jp-ResourceMonitor-panelLabel';
    key.textContent = label;

    const val = document.createElement('span');
    val.className = 'jp-ResourceMonitor-panelValue';
    val.textContent = value;

    row.appendChild(key);
    row.appendChild(val);
    return row;
  }

  private _tracker: INotebookTracker;
  private _serverSettings: ServerConnection.ISettings;
  private _trans: TranslationBundle;
  private _body: HTMLElement;
  private _poll: Poll;
  private _warned = false;
  private _failures = 0;
  private _pollState: IPollState = initialPollState();
}
