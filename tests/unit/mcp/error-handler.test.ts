import { unusedBroker } from '../../helpers/broker.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createMcpExpressApp } from '../../../src/services/mcp/adapters/express/server.js';
import { ToolRegistry } from '../../../src/services/tools/registry.js';
import { ProfileRegistry } from '../../../src/services/profiles/registry.js';
import { ProfileService } from '../../../src/services/profiles/base.js';
import { logger } from '../../../src/common/logger.js';

const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string };

let server: ReturnType<typeof createServer> | undefined;
let port = 0;

async function start() {
  const toolReg = new ToolRegistry();
  const profileReg = new ProfileRegistry();
  profileReg.addFileProfile('default', { tools: ['*'] });
  const svc = new ProfileService(profileReg, toolReg);
  const app = createMcpExpressApp(svc, toolReg, new Map(), [], { credentials: unusedBroker(), requireProfileToken: false });
  server = createServer(app);
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
}

function postRaw(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

/** No stack frames and no absolute filesystem paths in an error body. */
function expectNoLeak(text: string): void {
  expect(text).not.toMatch(/\bat /);
  expect(text).not.toMatch(/(^|[\s"'(>])\/[\w.-]+\//);
  expect(text).not.toMatch(/[A-Za-z]:\\/);
  expect(text).not.toContain('node_modules');
  expect(text).not.toContain('<html');
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>(r => server!.close(() => r()));
  server = undefined;
});

describe('MCP endpoint error responses', () => {
  it('answers a malformed JSON body with a JSON-RPC parse error and no stack', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await start();
    const res = await postRaw('{"jsonrpc": "2.0", "secret-marker": ');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.has('x-powered-by')).toBe(false);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    expectNoLeak(text);
    expect(warn).toHaveBeenCalledWith('mcp request failed', { status: 400, error_type: 'entity.parse.failed' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-marker');
  });

  it('answers a body over the JSON limit with a 413 JSON error', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await start();
    const res = await postRaw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(200 * 1024) } }));
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large' }, id: null });
    expectNoLeak(text);
  });

  it('answers GET on an unknown path with a 404 JSON body', async () => {
    await start();
    const res = await fetch(`http://127.0.0.1:${port}/no-such-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.has('x-powered-by')).toBe(false);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'not_found' });
    expectNoLeak(text);
  });

  it.each(['GET', 'DELETE'])('answers %s /mcp with 405 and an Allow header', async method => {
    await start();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const body = JSON.parse(await res.text());
    expect(body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  it('sends no X-Powered-By header on a successful request', async () => {
    await start();
    const res = await postRaw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), {
      Accept: 'application/json, text/event-stream',
    });
    await res.text();
    expect(res.headers.has('x-powered-by')).toBe(false);
  });
});

describe('MCP initialize', () => {
  it('reports the package version as serverInfo.version', async () => {
    await start();
    const res = await postRaw(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.0' } },
    }), { Accept: 'application/json, text/event-stream' });
    expect(res.status).toBe(200);
    const text = await res.text();
    const payload = text.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? text;
    const message = JSON.parse(payload) as { result: { serverInfo: { name: string; version: string } } };
    expect(message.result.serverInfo).toEqual({ name: 'splicedock', version: pkg.version });
  });
});
