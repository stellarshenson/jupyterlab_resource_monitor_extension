import { ServerConnection } from '@jupyterlab/services';

import { requestAPI } from '../request';

const settings = {
  baseUrl: 'http://localhost:8888/'
} as ServerConnection.ISettings;

/**
 * The endpoint is polled every few seconds, so its failure modes matter more
 * than its happy path: a body that is not JSON, and an error body that carries
 * no `message`, both used to throw before reaching the caller's `catch`.
 */
function reply(body: string, ok = true, status = 200): void {
  jest.spyOn(ServerConnection, 'makeRequest').mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(body)
  } as Response);
}

describe('requestAPI', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('addresses the extension namespace under the server base url', async () => {
    const spy = jest.spyOn(ServerConnection, 'makeRequest').mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}')
    } as Response);

    await requestAPI('metrics', settings);
    expect(spy.mock.calls[0][0]).toEqual(
      'http://localhost:8888/jupyterlab-resource-monitor-extension/metrics'
    );
  });

  it('parses a JSON body', async () => {
    reply('{"used_bytes": 42}');
    await expect(requestAPI('metrics', settings)).resolves.toEqual({
      used_bytes: 42
    });
  });

  it('returns an empty body untouched rather than failing to parse it', async () => {
    reply('');
    await expect(requestAPI('metrics', settings)).resolves.toEqual('');
  });

  it('raises a ResponseError on a non-JSON error page instead of a parse error', async () => {
    // the server serves an HTML 404 when the server extension is absent; a
    // JSON.parse throw here would mask the real cause from the caller
    reply('<html>404: Not Found</html>', false, 404);
    await expect(requestAPI('metrics', settings)).rejects.toThrow(
      ServerConnection.ResponseError
    );
  });

  it('surfaces the server message when the error body carries one', async () => {
    reply('{"message": "kernel gone"}', false, 500);
    await expect(requestAPI('metrics', settings)).rejects.toThrow(
      'kernel gone'
    );
  });

  it('wraps a transport failure as a NetworkError', async () => {
    jest
      .spyOn(ServerConnection, 'makeRequest')
      .mockRejectedValue(new Error('offline'));
    await expect(requestAPI('metrics', settings)).rejects.toThrow(
      ServerConnection.NetworkError
    );
  });
});
