import {
  HIDE_AFTER_FAILURES,
  initialPollState,
  IPollState,
  kernelPanelState,
  resolveDisplaySettings,
  shouldHideOnFailure,
  STALE_AFTER_POLLS,
  trackSnapshot
} from '../state';

const TOTAL = 16 * 1024 ** 3;

describe('trackSnapshot', () => {
  it('shows a fresh snapshot and records its timestamp', () => {
    const next = trackSnapshot(100, TOTAL, initialPollState());
    expect(next.hide).toBe(false);
    expect(next.lastTs).toEqual(100);
    expect(next.staleCount).toEqual(0);
  });

  it('keeps showing while the timestamp advances', () => {
    let state: IPollState = initialPollState();
    for (const ts of [100, 105, 110, 115, 120]) {
      const next = trackSnapshot(ts, TOTAL, state);
      expect(next.hide).toBe(false);
      state = next;
    }
    expect(state.staleCount).toEqual(0);
  });

  it('tolerates a repeated timestamp until the stale threshold', () => {
    // the sampler and the frontend poll on independent 5s cadences, so a
    // duplicate ts now and then is normal drift, not a stalled sampler
    let state: IPollState = trackSnapshot(100, TOTAL, initialPollState());
    for (let i = 1; i < STALE_AFTER_POLLS; i++) {
      const next = trackSnapshot(100, TOTAL, state);
      expect(next.hide).toBe(false);
      state = next;
    }
    // the poll that reaches the threshold hides
    expect(trackSnapshot(100, TOTAL, state).hide).toBe(true);
  });

  it('recovers as soon as a fresh timestamp arrives', () => {
    let state: IPollState = { lastTs: 100, staleCount: STALE_AFTER_POLLS };
    const next = trackSnapshot(101, TOTAL, state);
    expect(next.hide).toBe(false);
    expect(next.staleCount).toEqual(0);
    state = next;
    expect(trackSnapshot(102, TOTAL, state).hide).toBe(false);
  });

  it('hides a zero total rather than rendering it as live data', () => {
    // no /proc, or a hardened host: "Mem: 0 / 0 MB" would read as a real value
    expect(trackSnapshot(100, 0, initialPollState()).hide).toBe(true);
    expect(trackSnapshot(100, -1, initialPollState()).hide).toBe(true);
  });

  it('hides on a zero total even when the timestamp is fresh', () => {
    const state: IPollState = { lastTs: 99, staleCount: 0 };
    expect(trackSnapshot(100, 0, state).hide).toBe(true);
  });

  it('does not treat the initial state as a stale repeat', () => {
    // lastTs starts at -1, which no real snapshot carries
    const next = trackSnapshot(0, TOTAL, initialPollState());
    expect(next.staleCount).toEqual(0);
    expect(next.hide).toBe(false);
  });
});

describe('shouldHideOnFailure', () => {
  it('tolerates transient failures below the threshold', () => {
    for (let i = 1; i < HIDE_AFTER_FAILURES; i++) {
      expect(shouldHideOnFailure(i)).toBe(false);
    }
  });

  it('hides once the failures reach the threshold', () => {
    expect(shouldHideOnFailure(HIDE_AFTER_FAILURES)).toBe(true);
    expect(shouldHideOnFailure(HIDE_AFTER_FAILURES + 5)).toBe(true);
  });
});

describe('resolveDisplaySettings', () => {
  const from = (values: Record<string, unknown>) =>
    resolveDisplaySettings(key => values[key]);

  it('applies the schema defaults when nothing is set', () => {
    // unset must mean each toggle's own default, not one blanket direction
    const s = from({});
    expect(s.showMemory).toBe(true);
    expect(s.showCpu).toBe(true);
    expect(s.showKernelUsage).toBe(true);
    expect(s.showMemoryPercent).toBe(false);
    expect(s.cpuMode).toEqual('normalised');
  });

  it('honours explicit values in both directions', () => {
    const s = from({
      showMemory: false,
      showCpu: false,
      showKernelUsage: false,
      showMemoryPercent: true,
      cpuMode: 'bar'
    });
    expect(s.showMemory).toBe(false);
    expect(s.showCpu).toBe(false);
    expect(s.showKernelUsage).toBe(false);
    expect(s.showMemoryPercent).toBe(true);
    expect(s.cpuMode).toEqual('bar');
  });

  it('accepts every declared cpu mode and rejects anything else', () => {
    expect(from({ cpuMode: 'normalised' }).cpuMode).toEqual('normalised');
    expect(from({ cpuMode: 'aggregate' }).cpuMode).toEqual('aggregate');
    expect(from({ cpuMode: 'bar' }).cpuMode).toEqual('bar');
    expect(from({ cpuMode: 'nonsense' }).cpuMode).toEqual('normalised');
    expect(from({ cpuMode: null }).cpuMode).toEqual('normalised');
  });
});

describe('kernelPanelState', () => {
  const reading = { memory_bytes: 1024 ** 3, cpu_percent: 12 };
  const fresh = initialPollState();

  it('shows a real reading', () => {
    const r = kernelPanelState({
      kernel: reading,
      ts: 1,
      prev: fresh
    });
    expect(r.state).toEqual('reading');
  });

  it('measures until the first sample lands', () => {
    const r = kernelPanelState({
      kernel: null,
      ts: 0,
      prev: fresh
    });
    expect(r.state).toEqual('measuring');
  });

  it('does not present an all-zero sample as a live reading', () => {
    // a dead PID, or a host without /proc, reads as zeros all the way down
    const r = kernelPanelState({
      kernel: { memory_bytes: 0, cpu_percent: 0 },
      ts: 1,
      prev: fresh
    });
    expect(r.state).toEqual('measuring');
  });

  it('accepts a genuinely idle kernel that still holds memory', () => {
    const r = kernelPanelState({
      kernel: { memory_bytes: 82 * 1024 ** 2, cpu_percent: 0 },
      ts: 1,
      prev: fresh
    });
    expect(r.state).toEqual('reading');
  });

  it('stops presenting a frozen sample as live', () => {
    // the sampler thread wedged: the server keeps serving the same ts
    let prev = initialPollState();
    let last = '';
    for (let i = 0; i <= STALE_AFTER_POLLS; i++) {
      const r = kernelPanelState({ kernel: reading, ts: 7, prev });
      prev = { lastTs: r.lastTs, staleCount: r.staleCount };
      last = r.state;
    }
    expect(last).toEqual('measuring');
  });
});
