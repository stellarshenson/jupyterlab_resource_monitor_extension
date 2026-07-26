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
 * top-style sum where each core contributes its own 100%, `bar` shows the
 * normalised fraction as a filled bar instead of a number, and `grid` shows the
 * cores themselves as a square of cells.
 */
export type CpuMode = 'normalised' | 'aggregate' | 'bar' | 'grid';

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
 * Largest grid edge. Above this the cells go sub-pixel: the box is 13px with a
 * 1px border and 1px gaps, which divides exactly into 5px cells at 2x2, 3px at
 * 3x3 and 2px at 4x4.
 */
const GRID_MAX = 4;

/**
 * Where each cell is drawn, by edge length: `SPREAD[size][k]` is the position
 * of the k-th cell in load order.
 *
 * Without this the cells fill in reading order and, because Linux packs work
 * onto low-numbered CPUs, a partly loaded machine lights the top row and reads
 * as a progress bar. These are ordered-dithering sequences (4x4 is the Bayer
 * matrix), whose defining property is that every prefix is spread as evenly
 * over the square as that many cells can be.
 */
const SPREAD: { [size: number]: number[] } = {
  1: [0],
  2: [0, 3, 1, 2],
  3: [0, 8, 2, 6, 4, 1, 7, 3, 5],
  4: [0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12]
};

/**
 * Edge length of the grid, so the square holds no more cells than there are
 * cores to put in them.
 */
export function gridSize(count: number): number {
  const n = Number.isFinite(count) && count > 0 ? count : 1;
  return Math.min(Math.max(Math.floor(Math.sqrt(n)), 1), GRID_MAX);
}

/**
 * Average each cell's own cores. Slices are contiguous, and the remainder is
 * spread rather than dumped on the last cell: 6 cores over 4 cells gives
 * 1, 2, 1, 2.
 *
 * Contiguous is the point. Dealing cores round-robin would put one busy core in
 * every cell, so four pinned cores and a uniformly half-busy machine would draw
 * the same picture - which is the one distinction the grid exists to make.
 */
function bucketCores(perCore: number[], cells: number): number[] {
  const values: number[] = [];
  for (let k = 0; k < cells; k++) {
    // gridSize floors the edge length, so cells <= perCore.length always and
    // no slice can come out empty
    const from = Math.floor((k * perCore.length) / cells);
    const to = Math.floor(((k + 1) * perCore.length) / cells);
    let sum = 0;
    for (let i = from; i < to; i++) {
      sum += perCore[i];
    }
    values.push(sum / (to - from) / 100);
  }
  return values;
}

/**
 * Cell values in 0-1, in drawing order, left to right and top to bottom.
 *
 * Only ever called with real per-core readings. Without them there are no
 * cores to draw and the caller falls back to the bar: a scalar rendered into
 * scattered cells is strictly less legible than a scalar rendered as a fill,
 * because SPREAD exists to stop a monotone fill reading as a progress bar and
 * a gauge is exactly a monotone fill.
 */
export function cpuGridCells(perCore: number[]): {
  cells: number[];
  size: number;
} {
  const size = gridSize(perCore.length);
  const count = size * size;
  const cells = new Array<number>(count).fill(0);
  bucketCores(perCore, count).forEach((value, k) => {
    cells[SPREAD[size][k]] = value;
  });
  // the edge length travels with the values it describes: setGrid writes it
  // into gridTemplateColumns and cannot check it against the array it is given
  return { cells, size };
}

/**
 * Usage at which a cell stops gaining opacity and starts burning brighter.
 */
export const GRID_HOT = 0.75;

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
export function cpuTooltip(
  percent: number,
  cpuCount: number,
  grid?: 'cores' | 'allowance'
): string {
  const cpus = parseFloat(cpuCount.toFixed(2));
  // In grid mode the cells mean one of two different things, and the number
  // alone cannot say which - so the tooltip does, rather than leaving a user
  // to read a machine-wide picture as their own server's load.
  // 'allowance' states no cause: per-core readings go missing under a quota
  // narrower than the core set, but also on a masked /proc/stat or off Linux,
  // and naming a quota that may not exist is worse than naming nothing
  const shows =
    grid === 'cores'
      ? '; grid shows load on each core assigned to this server'
      : grid === 'allowance'
        ? '; no per-core readings here, so the bar shows the share of the CPU allowance in use'
        : '';
  return `CPU: ${Math.round(percent)}% of ${cpus} CPU${cpus === 1 ? '' : 's'}${shows}`;
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
