/**
 * Pure formatting helpers for the status bar items.
 */

const TB = 1024 ** 4;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

/**
 * Memory pressure level driving the status bar item's styling.
 */
export type MemLevel = 'normal' | 'warn' | 'danger';

/**
 * Format a byte count with a unit chosen for readability.
 */
export function formatBytes(bytes: number): string {
  // The tier is picked from the rounded value, not the raw one: a total a hair
  // under the boundary rounds up to "1024.0 GB" or "1024 MB" - the very strings
  // the tier above exists to avoid.
  if (bytes >= TB || Number((bytes / GB).toFixed(1)) >= 1024) {
    return `${(bytes / TB).toFixed(1)} TB`;
  }
  if (bytes >= GB || Math.round(bytes / MB) >= 1024) {
    return `${(bytes / GB).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / MB)} MB`;
}

function valueInUnit(bytes: number, unit: string): string {
  const div = unit === 'TB' ? TB : unit === 'GB' ? GB : MB;
  return unit === 'MB'
    ? `${Math.round(bytes / div)}`
    : (bytes / div).toFixed(1);
}

/**
 * Format the memory status text as `Mem: <used> / <total> <unit> (NN%)`.
 *
 * Used is expressed in the same unit as the total. The text is flush - single
 * spacing, no reserved-width padding - so the rendered width tracks the value.
 * The percentage suffix is included only when `percent` is a number; pass
 * `null` to omit it (the show-percentage setting is off).
 */
export function formatMemoryText(
  usedBytes: number,
  totalBytes: number,
  percent: number | null
): string {
  const [totalValue, unit] = formatBytes(totalBytes).split(' ');
  const used = valueInUnit(usedBytes, unit);
  const pct = percent === null ? '' : ` (${Math.round(percent)}%)`;
  return `Mem: ${used} / ${totalValue} ${unit}${pct}`;
}

/**
 * How the CPU reading is presented.
 *
 * The server reports a normalised percentage - busy time over all available
 * cores, so 100% means every core saturated. `aggregate` re-expands that to the
 * top-style sum where each core contributes its own 100%, and `bar` shows the
 * normalised fraction as a filled bar instead of a number.
 */
export type CpuMode = 'normalised' | 'aggregate' | 'bar';

/**
 * Format the CPU status text as `CPU: <n>%`, flush with no reserved width.
 *
 * In `aggregate` mode the normalised percentage is multiplied back out by the
 * core count, so a fully busy 8-core box reads `800%` as `top` would report it.
 */
export function formatCpuText(
  percent: number,
  mode: CpuMode = 'normalised',
  cpuCount = 1
): string {
  const value = mode === 'aggregate' ? percent * cpuCount : percent;
  return `CPU: ${Math.round(value)}%`;
}

/**
 * The fraction of total CPU capacity in use, clamped to 0-1 - the bar's fill,
 * full only when every available core is saturated.
 */
export function cpuFraction(percent: number): number {
  return Math.min(Math.max(percent / 100, 0), 1);
}

/**
 * Build the memory tooltip. It carries what the inline text cannot: whether the
 * ceiling is this container's cgroup limit or the host's RAM, and the severity
 * word, so the pressure level reaches assistive tech rather than being conveyed
 * by colour alone.
 */
export function memoryTooltip(
  usedBytes: number,
  totalBytes: number,
  percent: number,
  limitSource: string,
  level: MemLevel
): string {
  const limitLabel = limitSource === 'cgroup' ? 'container limit' : 'host RAM';
  const severity =
    level === 'danger' ? ', critical' : level === 'warn' ? ', high' : '';
  return `Memory: ${formatBytes(usedBytes)} used of ${formatBytes(
    totalBytes
  )} ${limitLabel} (${Math.round(percent)}%)${severity}`;
}

/**
 * Build the CPU tooltip, naming the denominator the percentage is taken over.
 *
 * `cpuCount` is a cgroup quota/period ratio, so it can be a long float (an odd
 * cfs period gives 0.3333333333333333); it is rounded for display only - the
 * server keeps the exact value for its percent maths.
 */
export function cpuTooltip(percent: number, cpuCount: number): string {
  const cpus = parseFloat(cpuCount.toFixed(2));
  return `CPU: ${Math.round(percent)}% of ${cpus} CPU${cpus === 1 ? '' : 's'}`;
}

/**
 * Resolve the memory pressure level from the used fraction with hysteresis,
 * so a value hovering at a threshold does not flip the styling every poll.
 * Danger enters at 0.95 and holds until below 0.92; warn enters at 0.90 and
 * holds until below 0.85.
 */
export function memoryLevel(fraction: number, prev: MemLevel): MemLevel {
  const dangerEnter = 0.95;
  const dangerExit = 0.92;
  const warnEnter = 0.9;
  const warnExit = 0.85;
  if (fraction >= dangerEnter) {
    return 'danger';
  }
  if (prev === 'danger' && fraction >= dangerExit) {
    return 'danger';
  }
  if (fraction >= warnEnter) {
    return 'warn';
  }
  if ((prev === 'warn' || prev === 'danger') && fraction >= warnExit) {
    return 'warn';
  }
  return 'normal';
}
