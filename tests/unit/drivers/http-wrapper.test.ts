import { describe, it, expect, vi, afterEach } from 'vitest';
import { callHttpTool } from '../../../src/adapters/outbound/drivers/http-wrapper.js';
import type { HttpToolConfig } from '../../../src/config/types.js';

function makeConfig(overrides: Partial<HttpToolConfig> = {}): HttpToolConfig {
  return {
    type: 'http',
    name: 'test_tool',
    namespace: 'test',
    description: 'Test tool',
    method: 'GET',
    url: 'https://api.example.com/resource',
    params: [],
    auth: { type: 'none' },
    ...overrides,
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('callHttpTool', () => {
  it('passes a materialized request to the simulator without resolving live auth or calling fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const exchange = vi.fn(async () => new Response('mock'));
    const config = makeConfig({
      method: 'POST', url: 'https://api.example.com/projects/{id}',
      params: [
        { name: 'id', in: 'path', required: true },
        { name: 'title', in: 'body', required: true },
      ],
      auth: { type: 'bearer', token: { from: 'env:TEST_UNSET_PREFLIGHT_TOKEN' } },
    });
    const result = await callHttpTool(config, { id: 'a/b', title: 'Demo' }, exchange);
    expect(result.content[0].text).toBe('mock');
    expect(exchange).toHaveBeenCalledExactlyOnceWith({
      method: 'POST', url: 'https://api.example.com/projects/a%2Fb', body: '{"title":"Demo"}',
    }, expect.any(Function));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses one guarded send and disables automatic redirects and retries', async () => {
    const fetch = vi.fn(async () => { throw new Error('network failed'); });
    vi.stubGlobal('fetch', fetch);
    const config = makeConfig({ retry: { max_attempts: 3, backoff_ms: 5 } });
    await expect(callHttpTool(config, {}, (_request, send) => send(new AbortController().signal)))
      .rejects.toThrow('network failed');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(config.url, expect.objectContaining({ redirect: 'error' }));
  });

  it('makes a GET request and returns text content on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'response body',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callHttpTool(makeConfig(), {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('response body');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/resource',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('substitutes path params in the URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'ok',
    });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig({
      url: 'https://api.example.com/issues/{issueKey}',
      params: [{ name: 'issueKey', in: 'path', required: true }],
    });
    await callHttpTool(config, { issueKey: 'JIRA-123' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/issues/JIRA-123',
      expect.any(Object),
    );
  });

  it('appends query params to the URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'ok',
    });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig({
      params: [{ name: 'project', in: 'query', required: false }],
    });
    await callHttpTool(config, { project: 'MYPROJ' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/resource?project=MYPROJ',
      expect.any(Object),
    );
  });

  it('sets bearer auth header', async () => {
    process.env.API_TOKEN = 'my-secret-token';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'ok',
    });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig({
      auth: { type: 'bearer', token: { from: 'env:API_TOKEN' } },
    });
    await callHttpTool(config, {});
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer my-secret-token' }),
      }),
    );
    delete process.env.API_TOKEN;
  });

  it('returns isError: true on 4xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callHttpTool(makeConfig(), {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTP 404');
  });

  it('returns isError: true on 5xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callHttpTool(makeConfig(), {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HTTP 500');
  });

  it('retries on network failure and succeeds on second attempt', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue({ ok: true, status: 200, text: async () => 'success' });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig({
      retry: { max_attempts: 2, backoff_ms: 10 },
    });
    const result = await callHttpTool(config, {});
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toBe('success');
  });

  it('throws after exhausting retries', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig({
      retry: { max_attempts: 2, backoff_ms: 10 },
    });
    await expect(callHttpTool(config, {})).rejects.toThrow('Network error');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('sends format: json body params as parsed JSON, not strings', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig({
      method: 'POST',
      params: [
        { name: 'model', in: 'body', required: false, default: 'model-latest' },
        { name: 'state', in: 'body', required: true },
        { name: 'questions', in: 'body', required: true, format: 'json' },
      ],
    });
    await callHttpTool(config, { state: 'hello', questions: '{"q":{"type":"noul","instructions":"?"}}' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ model: 'model-latest', state: 'hello', questions: { q: { type: 'noul', instructions: '?' } } });
  });

  it('omits an absent optional json param instead of sending an empty string', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig({
      method: 'POST',
      params: [
        { name: 'a', in: 'body', required: true },
        { name: 'extra', in: 'body', required: false, format: 'json' },
      ],
    });
    await callHttpTool(config, { a: 'x' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ a: 'x' });
  });

  it('returns an error without calling fetch when a json param is not valid JSON', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const config = makeConfig({
      method: 'POST',
      params: [{ name: 'questions', in: 'body', required: true, format: 'json' }],
    });
    const result = await callHttpTool(config, { questions: '{not json' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("'questions'");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses a configured timeout_ms for the abort signal, else defaults to 30s', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
    vi.stubGlobal('fetch', mockFetch);
    const spy = vi.spyOn(AbortSignal, 'timeout');

    await callHttpTool(makeConfig({ timeout_ms: 950_000 }), {});
    expect(spy).toHaveBeenLastCalledWith(950_000);

    await callHttpTool(makeConfig(), {}); // no timeout_ms -> 30s default
    expect(spy).toHaveBeenLastCalledWith(30_000);
  });
});
