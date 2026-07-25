/**
 * Poll-state decisions for the status bar, kept pure so the invariants they
 * enforce - never present a frozen snapshot as live, never render missing data
 * as a real reading, tolerate a transient failure - are unit testable rather
 * than buried in the plugin's activation closure.
 */

/**
 * Consecutive polls with an unchanged timestamp before the snapshot is treated
 * as stale - the sampler thread has stopped producing samples.
 */
export const STALE_AFTER_POLLS = 3;

/**
 * Consecutive failed polls tolerated before the items are hidden, so a single
 * transient hiccup (laptop wake, proxy blip) does not read as a crash.
 */
export const HIDE_AFTER_FAILURES = 3;

/**
 * What the last few polls have established about the snapshot's freshness.
 */
export interface IPollState {
  lastTs: number;
  staleCount: number;
}

/**
 * The state a fresh plugin starts from: no timestamp seen yet.
 */
export function initialPollState(): IPollState {
  return { lastTs: -1, staleCount: 0 };
}

/**
 * Fold one successful poll into the state and decide whether to show it.
 *
 * `hide` is true when the sampler has stopped stamping fresh timestamps for
 * `STALE_AFTER_POLLS` polls, or when the snapshot carries no usable total
 * (no `/proc`, hardened host) - either way the items hide rather than present
 * stale or zero data as a live reading.
 */
export function trackSnapshot(
  ts: number,
  totalBytes: number,
  prev: IPollState
): IPollState & { hide: boolean } {
  const staleCount = ts === prev.lastTs ? prev.staleCount + 1 : 0;
  const hide = staleCount >= STALE_AFTER_POLLS || totalBytes <= 0;
  return { lastTs: ts, staleCount, hide };
}

/**
 * Whether a run of consecutive failures has gone on long enough to hide the
 * items, rather than leaving a stale reading up indefinitely.
 */
export function shouldHideOnFailure(failures: number): boolean {
  return failures >= HIDE_AFTER_FAILURES;
}

/**
 * Poll interval for the metrics endpoints, in milliseconds.
 */
export const POLL_INTERVAL = 5000;

/**
 * Ceiling the backoff may raise the interval to while an endpoint is failing,
 * so a dead server is retried once a minute rather than never.
 */
export const MAX_POLL_INTERVAL = 60000;

/**
 * The display settings, resolved to concrete values.
 */
export interface IDisplaySettings {
  showMemory: boolean;
  showCpu: boolean;
  showMemoryPercent: boolean;
  cpuMode: 'normalised' | 'aggregate' | 'bar';
  showKernelUsage: boolean;
}

/**
 * Resolve the display settings from a raw getter.
 *
 * Each toggle is read in the direction of its own schema default: the ones
 * that default on treat anything but an explicit `false` as on, and
 * `showMemoryPercent`, which defaults off, requires an explicit `true`. Read
 * the wrong way round, a setting silently inverts when its default changes -
 * which has already happened twice.
 */
export function resolveDisplaySettings(
  get: (key: string) => unknown
): IDisplaySettings {
  const mode = get('cpuMode');
  return {
    showMemory: get('showMemory') !== false,
    showCpu: get('showCpu') !== false,
    showKernelUsage: get('showKernelUsage') !== false,
    showMemoryPercent: get('showMemoryPercent') === true,
    cpuMode: mode === 'aggregate' || mode === 'bar' ? mode : 'normalised'
  };
}

/**
 * What the kernel panel should display for one poll.
 */
export type KernelPanelState = 'reading' | 'measuring';

/**
 * A kernel sample as the server reports it.
 */
export interface IKernelReading {
  memory_bytes: number;
  cpu_percent: number;
}

/**
 * Decide what the kernel panel shows for a poll that succeeded, applying the
 * same discipline the status bar uses: never present a frozen snapshot as
 * live, and never render an all-zero sample - which is what a dead PID or a
 * host without `/proc` produces - as a real reading. Failed polls never reach
 * here; the panel counts those itself against `shouldHideOnFailure`.
 */
export function kernelPanelState(options: {
  kernel: IKernelReading | null;
  ts: number;
  prev: IPollState;
}): { state: KernelPanelState; lastTs: number; staleCount: number } {
  const { kernel, ts, prev } = options;

  const staleCount = ts === prev.lastTs ? prev.staleCount + 1 : 0;
  const lastTs = ts;

  // a kernel is watched only from the first poll onward, so the first response
  // for a freshly selected kernel legitimately carries no sample
  if (!kernel) {
    return { state: 'measuring', lastTs, staleCount: 0 };
  }
  if (kernel.memory_bytes <= 0 && kernel.cpu_percent <= 0) {
    return { state: 'measuring', lastTs, staleCount };
  }
  if (staleCount >= STALE_AFTER_POLLS) {
    return { state: 'measuring', lastTs, staleCount };
  }
  return { state: 'reading', lastTs, staleCount };
}
