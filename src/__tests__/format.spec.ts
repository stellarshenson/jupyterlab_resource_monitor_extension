import {
  cpuFraction,
  cpuGridCells,
  cpuTooltip,
  formatBytes,
  formatCpuText,
  formatMemoryText,
  GRID_HOT,
  gridSize,
  MemLevel,
  memoryLevel,
  memoryTooltip
} from '../format';

describe('format', () => {
  describe('formatBytes', () => {
    it('formats terabytes with one decimal', () => {
      expect(formatBytes(2 * 1024 ** 4)).toEqual('2.0 TB');
    });

    it('formats gigabytes with one decimal', () => {
      expect(formatBytes(3.42 * 1024 ** 3)).toEqual('3.4 GB');
    });

    it('formats sub-gigabyte values as megabytes', () => {
      expect(formatBytes(350 * 1024 ** 2)).toEqual('350 MB');
    });

    it('formats zero', () => {
      expect(formatBytes(0)).toEqual('0 MB');
    });

    it('promotes a tier when the value rounds up to the boundary', () => {
      // a limit a hair under the boundary must not render as the next tier's
      // floor - "1024.0 GB" is the string the TB tier exists to avoid
      expect(formatBytes(1023.99 * 1024 ** 3)).toEqual('1.0 TB');
      expect(formatBytes(1023.7 * 1024 ** 2)).toEqual('1.0 GB');
      expect(formatBytes(1023.4 * 1024 ** 2)).toEqual('1023 MB');
    });
  });

  describe('formatMemoryText', () => {
    const TB = 1024 ** 4;
    const GB = 1024 ** 3;
    const MB = 1024 ** 2;

    it('expresses used in TB on a terabyte-class node', () => {
      expect(formatMemoryText(0.5 * TB, 1.5 * TB, 33)).toEqual(
        'Mem: 0.5 / 1.5 TB (33%)'
      );
    });

    it('shows used in the total unit with the percentage', () => {
      expect(formatMemoryText(3.4 * GB, 15.6 * GB, 22)).toEqual(
        'Mem: 3.4 / 15.6 GB (22%)'
      );
    });

    it('expresses a sub-unit used value in the total unit', () => {
      expect(formatMemoryText(350 * MB, 16 * GB, 2)).toEqual(
        'Mem: 0.3 / 16.0 GB (2%)'
      );
    });

    it('rounds the percentage', () => {
      expect(formatMemoryText(14.2 * GB, 15.6 * GB, 91.2)).toEqual(
        'Mem: 14.2 / 15.6 GB (91%)'
      );
    });

    it('omits the percentage when it is null', () => {
      expect(formatMemoryText(3.4 * GB, 15.6 * GB, null)).toEqual(
        'Mem: 3.4 / 15.6 GB'
      );
    });

    it('renders flush, so the width tracks the value', () => {
      const low = formatMemoryText(3.4 * GB, 512 * GB, 1);
      const high = formatMemoryText(511.9 * GB, 512 * GB, 100);
      expect(low).toEqual('Mem: 3.4 / 512.0 GB (1%)');
      expect(high).toEqual('Mem: 511.9 / 512.0 GB (100%)');
      expect(low.length).not.toEqual(high.length);
    });
  });

  describe('formatCpuText', () => {
    it('rounds to a whole percent', () => {
      expect(formatCpuText(7.4)).toEqual('CPU: 7%');
    });

    it('renders flush across magnitudes', () => {
      expect(formatCpuText(5)).toEqual('CPU: 5%');
      expect(formatCpuText(100)).toEqual('CPU: 100%');
    });

    it('expands to the top-style sum in aggregate mode', () => {
      // 45% of an 8-core box is 360% when each core counts its own 100%
      expect(formatCpuText(45, 'aggregate', 8)).toEqual('CPU: 360%');
      expect(formatCpuText(100, 'aggregate', 8)).toEqual('CPU: 800%');
    });

    it('leaves the reading normalised in normalised mode', () => {
      expect(formatCpuText(45, 'normalised', 8)).toEqual('CPU: 45%');
    });
  });

  describe('cpuFraction', () => {
    it('is the share of total capacity, full only when all cores are busy', () => {
      expect(cpuFraction(0)).toEqual(0);
      expect(cpuFraction(50)).toEqual(0.5);
      expect(cpuFraction(100)).toEqual(1);
    });

    it('clamps out-of-range readings', () => {
      expect(cpuFraction(-5)).toEqual(0);
      expect(cpuFraction(140)).toEqual(1);
    });
  });

  describe('gridSize', () => {
    it('never holds more cells than there are cores', () => {
      // the square is the largest that fits inside the core count
      expect(gridSize(4)).toEqual(2);
      expect(gridSize(8)).toEqual(2); // 3x3 would be 9 cells for 8 cores
      expect(gridSize(9)).toEqual(3);
      expect(gridSize(16)).toEqual(4);
    });

    it('caps the edge so cells never go sub-pixel', () => {
      // 5x5 in a 13px box would be under 2px a cell
      expect(gridSize(25)).toEqual(4);
      expect(gridSize(64)).toEqual(4);
    });

    it('collapses to a single cell on a machine too small to divide', () => {
      expect(gridSize(1)).toEqual(1);
      expect(gridSize(2)).toEqual(1);
    });

    it('survives a missing or nonsensical count', () => {
      expect(gridSize(0)).toEqual(1);
      expect(gridSize(NaN)).toEqual(1);
    });
  });

  describe('cpuGridCells', () => {
    const cellsOf = (perCore: number[]): number[] =>
      cpuGridCells(perCore).cells;

    it('averages the cores in each cell', () => {
      // 8 cores over 4 cells, two cores apiece
      expect(cellsOf([100, 0, 0, 0, 0, 0, 0, 0])).toEqual([0.5, 0, 0, 0]);
    });

    it('returns the edge length that describes the cells it returns', () => {
      // setGrid is handed both and cannot check one against the other, so they
      // have to leave here as a pair
      expect(cpuGridCells([0, 0, 0, 0])).toEqual({
        cells: [0, 0, 0, 0],
        size: 2
      });
      expect(cpuGridCells(Array(16).fill(0)).size).toEqual(4);
    });

    it('spreads the lit cells instead of filling the top row', () => {
      // Four of eight cores pinned. Drawn in reading order this lights cells 0
      // and 1 - the whole top row - and reads as a half-full progress bar;
      // spread, it reads as half the machine.
      expect(cellsOf([100, 100, 100, 100, 0, 0, 0, 0])).toEqual([1, 0, 0, 1]);
    });

    it('spreads a 4x4 the same way, on the hardware that gets one', () => {
      // 64 cores is a 4x4 of 4 cores each, and every 2x2 case above resolves
      // to SPREAD[2] - so without this, SPREAD[4] could be reading order and
      // the whole suite stays green while the grid fills its top row
      const perCore = Array.from({ length: 64 }, (_unused, i) =>
        i < 16 ? 100 : 0
      );
      expect(cellsOf(perCore)).toEqual([
        1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0
      ]);
    });

    it('spreads a 3x3 too', () => {
      // 9 cores, one cell each; the first three light both top corners and the
      // bottom-right, never three in a row
      const perCore = [100, 100, 100, 0, 0, 0, 0, 0, 0];
      expect(cellsOf(perCore)).toEqual([1, 0, 1, 0, 0, 0, 0, 0, 1]);
    });

    it.each([1, 4, 9, 16])(
      'fills every cell with %i cores saturated',
      cores => {
        // A duplicated index in SPREAD would write two buckets into one cell and
        // leave another at its zero default - one core group's load vanishing,
        // one cell permanently dark. Saturating every core is what exposes it:
        // asserting distinct outputs does NOT, because the abandoned cell's zero
        // is itself a distinct value and the count comes out right regardless.
        const out = cellsOf(Array(cores).fill(100));
        expect(out).toHaveLength(cores);
        expect(out).toEqual(Array(cores).fill(1));
      }
    );

    it('spreads the remainder rather than dumping it on the last cell', () => {
      // 6 cores over 4 cells gives slices of 1, 2, 1, 2
      // core 1 shares the two-wide second slice, so its cell averages to half
      expect(cellsOf([0, 100, 0, 0, 0, 0])).toEqual([0, 0, 0, 0.5]);
      // core 3 has the third slice to itself, so it fills its cell outright
      expect(cellsOf([0, 0, 0, 100, 0, 0])).toEqual([0, 1, 0, 0]);
    });

    it('distinguishes a few pinned cores from an evenly busy machine', () => {
      // the whole point of the mode: both of these are ~50% aggregate
      const pinned = cellsOf([100, 100, 100, 100, 0, 0, 0, 0]);
      const even = cellsOf([50, 50, 50, 50, 50, 50, 50, 50]);
      expect(pinned).not.toEqual(even);
      expect(even).toEqual([0.5, 0.5, 0.5, 0.5]);
    });
  });

  describe('GRID_HOT', () => {
    it('is the 75% the README promises users', () => {
      // a published contract, so pin the literal - item.spec asserts either
      // side of the constant and would follow it anywhere it drifted
      expect(GRID_HOT).toEqual(0.75);
    });
  });

  describe('memoryTooltip', () => {
    const GB = 1024 ** 3;

    it('names a cgroup ceiling as the container limit', () => {
      expect(
        memoryTooltip(3.4 * GB, 16 * GB, 21.25, 'cgroup', 'normal')
      ).toEqual('Memory: 3.4 GB used of 16.0 GB container limit (21%)');
    });

    it('names a host ceiling as host RAM', () => {
      expect(memoryTooltip(3.4 * GB, 16 * GB, 21.25, 'host', 'normal')).toEqual(
        'Memory: 3.4 GB used of 16.0 GB host RAM (21%)'
      );
    });

    it('appends the severity word so pressure is not colour-only', () => {
      expect(memoryTooltip(15 * GB, 16 * GB, 93.75, 'host', 'warn')).toEqual(
        'Memory: 15.0 GB used of 16.0 GB host RAM (94%), high'
      );
      expect(memoryTooltip(15.5 * GB, 16 * GB, 96.9, 'host', 'danger')).toEqual(
        'Memory: 15.5 GB used of 16.0 GB host RAM (97%), critical'
      );
    });
  });

  describe('cpuTooltip', () => {
    it('names the denominator and pluralises it', () => {
      expect(cpuTooltip(7.4, 8)).toEqual('CPU: 7% of 8 CPUs');
      expect(cpuTooltip(50, 1)).toEqual('CPU: 50% of 1 CPU');
    });

    it('rounds a quota ratio for display without trailing zeros', () => {
      // an odd cfs period yields 0.3333333333333333 from quota/period
      expect(cpuTooltip(12, 1 / 3)).toEqual('CPU: 12% of 0.33 CPUs');
      expect(cpuTooltip(12, 0.5)).toEqual('CPU: 12% of 0.5 CPUs');
      expect(cpuTooltip(12, 2)).toEqual('CPU: 12% of 2 CPUs');
    });

    it('says what the grid is showing when a grid is drawn', () => {
      // the cells are the load on cores the server shares with whoever else
      // is on them, not the server's own usage split per core, and the number
      // alone cannot say so
      expect(cpuTooltip(40, 8, 'cores')).toEqual(
        'CPU: 40% of 8 CPUs; grid shows load on each core assigned to this server'
      );
    });

    it('says why a bar is drawn in grid mode instead', () => {
      // no cause named: the readings go missing under a narrow quota, but also
      // on a masked /proc/stat, and only one of those involves a quota
      expect(cpuTooltip(40, 2, 'allowance')).toEqual(
        'CPU: 40% of 2 CPUs; no per-core readings here, so the bar shows the share of the CPU allowance in use'
      );
    });

    it('stays silent about the grid in every other mode', () => {
      expect(cpuTooltip(40, 8)).toEqual('CPU: 40% of 8 CPUs');
      expect(cpuTooltip(40, 8, undefined)).toEqual('CPU: 40% of 8 CPUs');
    });
  });

  describe('memoryLevel', () => {
    it('is normal below the warn threshold', () => {
      expect(memoryLevel(0.5, 'normal')).toEqual('normal');
      expect(memoryLevel(0.89, 'normal')).toEqual('normal');
    });

    it('enters warn at 0.90 and danger at 0.95', () => {
      expect(memoryLevel(0.9, 'normal')).toEqual('warn');
      expect(memoryLevel(0.95, 'normal')).toEqual('danger');
    });

    it('holds danger down to the exit band (hysteresis)', () => {
      expect(memoryLevel(0.93, 'danger')).toEqual('danger');
      expect(memoryLevel(0.91, 'danger')).toEqual('warn');
    });

    it('holds warn down to the exit band (hysteresis)', () => {
      expect(memoryLevel(0.86, 'warn')).toEqual('warn');
      expect(memoryLevel(0.84, 'warn')).toEqual('normal');
    });

    it('does not flip on a single poll hovering at the entry threshold', () => {
      let level: MemLevel = 'normal';
      // rise to warn, then dip to 0.88 - stays warn instead of flickering
      level = memoryLevel(0.9, level);
      expect(level).toEqual('warn');
      level = memoryLevel(0.88, level);
      expect(level).toEqual('warn');
      level = memoryLevel(0.9, level);
      expect(level).toEqual('warn');
    });
  });
});
