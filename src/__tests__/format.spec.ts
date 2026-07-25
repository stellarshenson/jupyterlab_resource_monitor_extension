import {
  cpuFraction,
  cpuTooltip,
  formatBytes,
  formatCpuText,
  formatMemoryText,
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
