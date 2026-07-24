import {
  cpuSegments,
  cpuTooltip,
  formatBytes,
  ISegment,
  MemLevel,
  memoryLevel,
  memorySegments,
  memoryTooltip
} from '../format';

// The rendered string, as the status bar item's textContent reads it.
const text = (segments: ISegment[]): string =>
  segments.map(s => s.text).join('');

// The layout the renderer reserves: literal runs by their text, numeric runs
// by their column count. Equal layouts render at equal width.
const layout = (segments: ISegment[]): (string | number)[] =>
  segments.map(s => s.columns ?? s.text);

describe('jupyterlab_resource_monitor_extension', () => {
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

  describe('memorySegments', () => {
    const TB = 1024 ** 4;
    const GB = 1024 ** 3;
    const MB = 1024 ** 2;

    it('expresses used in TB on a terabyte-class node', () => {
      expect(text(memorySegments(0.5 * TB, 1.5 * TB, 33))).toEqual(
        'Mem: 0.5 / 1.5 TB (33%)'
      );
    });

    it('shows used in the total unit with the percentage', () => {
      expect(text(memorySegments(3.4 * GB, 15.6 * GB, 22))).toEqual(
        'Mem: 3.4 / 15.6 GB (22%)'
      );
    });

    it('expresses a sub-unit used value in the total unit', () => {
      expect(text(memorySegments(350 * MB, 16 * GB, 2))).toEqual(
        'Mem: 0.3 / 16.0 GB (2%)'
      );
    });

    it('rounds the percentage', () => {
      expect(text(memorySegments(14.2 * GB, 15.6 * GB, 91.2))).toEqual(
        'Mem: 14.2 / 15.6 GB (91%)'
      );
    });

    it('reserves the same layout for a fixed total', () => {
      const total = 512 * GB;
      expect(layout(memorySegments(3.4 * GB, total, 1))).toEqual(
        layout(memorySegments(511.9 * GB, total, 100))
      );
    });

    it('never overflows a reserved column', () => {
      const total = 512 * GB;
      for (const percent of [0, 50, 100]) {
        for (const segment of memorySegments(
          total * (percent / 100),
          total,
          percent
        )) {
          if (segment.columns !== undefined) {
            expect(segment.text.length).toBeLessThanOrEqual(segment.columns);
          }
        }
      }
    });
  });

  describe('cpuSegments', () => {
    it('rounds to a whole percent', () => {
      expect(text(cpuSegments(7.4))).toEqual('CPU: 7%');
    });

    it('reserves the same layout across magnitudes', () => {
      expect(layout(cpuSegments(5))).toEqual(layout(cpuSegments(100)));
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
