import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { createMcpExpressApp } from '../../../src/adapters/inbound/mcp/server.js';
import { createQueryFallbackWarner, QUERY_FALLBACK_WARN_INTERVAL_MS } from '../../../src/adapters/inbound/mcp/profile-selection.js';
import { createMetrics } from '../../../src/common/metrics.js';
import { ToolRegistry } from '../../../src/application/registry/tool-registry.js';
import { ProfileRegistry } from '../../../src/application/registry/profile-registry.js';
import { ProfileService } from '../../../src/application/profiles/profile-service.js';
import { logger } from '../../../src/common/logger.js';

let server: ReturnType<typeof createServer> | undefined;
let port = 0;

async function start(opts: { requireProfileToken?: boolean; metrics?: boolean }) {
  const toolReg = new ToolRegistry();
  const profileReg = new ProfileRegistry();
  profileReg.addFileProfile('default', { tools: ['*'] });
  profileReg.addFileProfile('ops', { tools: ['*'] });
  const svc = new ProfileService(profileReg, toolReg);
  const metrics = opts.metrics ? createMetrics() : undefined;
  const app = createMcpExpressApp(svc, toolReg, new Map(), [], {
    lookupProfileByToken: t => (t === 'good' ? 'ops' : null),
    requireProfileToken: opts.requireProfileToken,
    metrics,
  });
  server = createServer(app);
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  return metrics;
}

function post(headers: Record<string, string>, query = ''): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

async function selection(m: ReturnType<typeof createMetrics>, source: string): Promise<number> {
  const text = await m.registry.metrics();
  const line = text.split('\n').find(l => l.startsWith('splicedock_profile_selection_total') && l.includes(`source="${source}"`));
  return line ? Number(line.split(' ').pop()) : 0;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>(r => server!.close(() => r()));
  server = undefined;
});

describe('require_profile_token = true', () => {
  it('rejects a request with no bearer (401)', async () => {
    await start({ requireProfileToken: true });
    const res = await post({});
    expect(res.status).toBe(401);
  });

  it('ignores ?profile= entirely when no bearer is present (401)', async () => {
    await start({ requireProfileToken: true });
    const res = await post({}, '?profile=default');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid bearer (401)', async () => {
    await start({ requireProfileToken: true });
    const res = await post({ Authorization: 'Bearer nope' }, '?profile=default');
    expect(res.status).toBe(401);
  });

  it('accepts a valid bearer, and ?profile= alongside it does not change the bound profile', async () => {
    const m = await start({ requireProfileToken: true, metrics: true });
    const res = await post({ Authorization: 'Bearer good' }, '?profile=default');
    expect(res.status).not.toBe(401);
    expect(await selection(m!, 'bearer')).toBe(1);
    expect(await selection(m!, 'legacy_query')).toBe(0);
  });

  it('does not log a query-fallback warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await start({ requireProfileToken: true });
    await post({}, '?profile=default');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('require_profile_token = false (default)', () => {
  it('keeps the legacy ?profile= path and counts selection sources', async () => {
    const m = await start({ metrics: true });
    const legacy = await post({}, '?profile=ops');
    expect(legacy.status).not.toBe(401);
    expect(legacy.headers.get('Deprecation')).toMatch(/^@\d+$/);
    expect(legacy.headers.get('Link')).toContain('rel="deprecation"');
    const bound = await post({ Authorization: 'Bearer good' }, '?profile=default');
    expect(bound.headers.has('Deprecation')).toBe(false);
    expect((await post({})).status).not.toBe(401);
    expect((await post({ Authorization: 'Bearer good' })).status).not.toBe(401);
    expect(await selection(m!, 'legacy_query')).toBe(1);
    expect(await selection(m!, 'none')).toBe(1);
    expect(await selection(m!, 'bearer')).toBe(2);
  });

  it('warns once per profile on query fallback, with the profile name only', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await start({});
    await post({}, '?profile=ops');
    await post({}, '?profile=ops');
    await post({}, '?profile=default');
    const calls = warn.mock.calls.filter(c => String(c[0]).includes('query'));
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toMatch(/good|Bearer/);
  });
});

describe('createQueryFallbackWarner', () => {
  it('dedupes per profile within the interval and re-warns after it', () => {
    let now = 1_000;
    const warn = vi.fn();
    const w = createQueryFallbackWarner(warn, () => now);
    w('ops');
    w('ops');
    expect(warn).toHaveBeenCalledTimes(1);
    w('other');
    expect(warn).toHaveBeenCalledTimes(2);
    now += QUERY_FALLBACK_WARN_INTERVAL_MS + 1;
    w('ops');
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
