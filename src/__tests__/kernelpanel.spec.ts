jest.mock('../request', () => ({ requestAPI: jest.fn() }));

import { ServerConnection } from '@jupyterlab/services';

import { nullTranslator } from '@jupyterlab/translation';

import { Signal } from '@lumino/signaling';

import { KernelUsagePanel } from '../kernelpanel';

import { requestAPI } from '../request';

const mockRequest = requestAPI as jest.MockedFunction<typeof requestAPI>;

const trans = nullTranslator.load('jupyterlab_resource_monitor_extension');

/**
 * A notebook tracker carrying just what the panel reads: the current widget's
 * kernel id, and a signal for switching notebooks.
 */
function makeTracker(kernelId: string | null): any {
  const owner = {};
  return {
    currentChanged: new Signal<any, any>(owner),
    currentWidget: kernelId
      ? { sessionContext: { session: { kernel: { id: kernelId } } } }
      : null
  };
}

function makePanel(kernelId: string | null): KernelUsagePanel {
  return new KernelUsagePanel({
    tracker: makeTracker(kernelId),
    serverSettings: {} as ServerConnection.ISettings,
    trans
  });
}

describe('KernelUsagePanel', () => {
  let panel: KernelUsagePanel | null = null;

  beforeEach(() => {
    mockRequest.mockReset();
  });

  afterEach(() => {
    panel?.dispose();
    panel = null;
  });

  const update = (p: KernelUsagePanel): Promise<void> => (p as any)._update();

  it('reports no kernel when no notebook is current', async () => {
    panel = makePanel(null);
    await update(panel);
    expect(panel.node.textContent).toContain('No kernel');
    // nothing to ask about, so the endpoint is never called
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('asks the endpoint for the current notebook kernel only', async () => {
    mockRequest.mockResolvedValue({ kernel: null, ts: 0 } as any);
    panel = makePanel('abc-123');
    await update(panel);
    expect(mockRequest).toHaveBeenCalledWith(
      'kernels?kernel_id=abc-123',
      expect.anything()
    );
  });

  it('url-encodes the kernel id', async () => {
    mockRequest.mockResolvedValue({ kernel: null, ts: 0 } as any);
    panel = makePanel('a b/c');
    await update(panel);
    expect(mockRequest).toHaveBeenCalledWith(
      'kernels?kernel_id=a%20b%2Fc',
      expect.anything()
    );
  });

  it('shows a measuring state until the first sample lands', async () => {
    // a kernel is watched only from the first poll onward, so the first
    // response for a freshly selected kernel legitimately carries no sample
    mockRequest.mockResolvedValue({ kernel: null, ts: 0 } as any);
    panel = makePanel('abc-123');
    await update(panel);
    expect(panel.node.textContent).toContain('Measuring');
  });

  it('renders the kernel reading once a sample arrives', async () => {
    mockRequest.mockResolvedValue({
      kernel: {
        id: 'abc-123',
        name: 'python3',
        memory_bytes: 682 * 1024 ** 2,
        cpu_percent: 101.4
      },
      ts: 12345
    } as any);
    panel = makePanel('abc-123');
    await update(panel);

    const text = panel.node.textContent ?? '';
    expect(text).toContain('python3');
    expect(text).toContain('682 MB');
    expect(text).toContain('101%');
  });

  it('rethrows a failed poll so the poll backs off', async () => {
    mockRequest.mockRejectedValue(new Error('boom'));
    panel = makePanel('abc-123');
    await expect(update(panel)).rejects.toThrow('boom');
  });

  it('rides out a transient failure without crying unavailable', async () => {
    // a laptop wake or proxy blip is not a crash - the status bar tolerates
    // three strikes and the panel must match
    mockRequest.mockRejectedValue(new Error('boom'));
    panel = makePanel('abc-123');
    await expect(update(panel)).rejects.toThrow();
    expect(panel.node.textContent).not.toContain('Unavailable');
  });

  it('reports unavailable once the failures persist', async () => {
    mockRequest.mockRejectedValue(new Error('boom'));
    panel = makePanel('abc-123');
    for (let i = 0; i < 3; i++) {
      await expect(update(panel)).rejects.toThrow();
    }
    expect(panel.node.textContent).toContain('Unavailable');
  });

  it('warns once, not on every failed poll', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    mockRequest.mockRejectedValue(new Error('boom'));
    panel = makePanel('abc-123');
    await expect(update(panel)).rejects.toThrow();
    await expect(update(panel)).rejects.toThrow();
    await expect(update(panel)).rejects.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('resets to no kernel when the notebook changes', async () => {
    mockRequest.mockResolvedValue({
      kernel: {
        id: 'abc-123',
        name: 'python3',
        memory_bytes: 1024 ** 3,
        cpu_percent: 5
      },
      ts: 1
    } as any);
    const tracker = makeTracker('abc-123');
    panel = new KernelUsagePanel({
      tracker,
      serverSettings: {} as ServerConnection.ISettings,
      trans
    });
    await update(panel);
    expect(panel.node.textContent).toContain('python3');

    // switching notebooks must clear at once, not leave the previous kernel's
    // numbers up until the next poll lands
    tracker.currentChanged.emit(undefined);
    expect(panel.node.textContent).toContain('No kernel');
  });

  it('drops its tracker connection when disposed', () => {
    const tracker = makeTracker('abc-123');
    const p = new KernelUsagePanel({
      tracker,
      serverSettings: {} as ServerConnection.ISettings,
      trans
    });
    p.dispose();
    // a notebook switch after disposal must not reach the disposed poll
    expect(() => tracker.currentChanged.emit(undefined)).not.toThrow();
  });
});
