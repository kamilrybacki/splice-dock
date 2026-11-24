import { resolveBoundProfile } from '../../../src/services/mcp/base.js';
import { createServer } from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { ProfileService } from '../../../src/services/profiles/base.js';
import { ToolRegistry } from '../../../src/services/tools/tool-registry.js';
import { ProfileRegistry } from '../../../src/services/profiles/profile-registry.js';
import { createMcpExpressApp } from '../../../src/services/mcp/adapters/express/server.js';

describe('resolveBoundProfile', () => {
  it('binds the profile a valid bearer resolves to (the caller then ignores ?profile=)', async () => {
    const r = await resolveBoundProfile('Bearer good', () => 'ops');
    expect(r).toMatchObject({ profile: 'ops', unauthorized: false });
    expect(r.tokenId).toMatch(/^tok-[0-9a-f]{16}$/);
    expect(r.tokenId).not.toContain('good');
  });
  it('flags a bearer that resolves to nothing as unauthorized, with no fallback', async () => {
    expect(await resolveBoundProfile('Bearer nope', () => null)).toEqual({ profile: null, unauthorized: true });
  });
  it('is a no-op for an absent header (caller keeps legacy ?profile=)', async () => {
    expect(await resolveBoundProfile(undefined, () => 'ops')).toEqual({ profile: null, unauthorized: false });
  });
  it('is a no-op for a non-Bearer scheme', async () => {
    expect(await resolveBoundProfile('Basic Zm9v', () => 'ops')).toEqual({ profile: null, unauthorized: false });
  });
  it('is a no-op for an empty bearer', async () => {
    expect(await resolveBoundProfile('Bearer   ', () => 'ops')).toEqual({ profile: null, unauthorized: false });
  });
});

describe('POST /mcp — bearer profile binding', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  function build(lookup: (t: string) => string | null): ReturnType<typeof createServer> {
    const toolReg = new ToolRegistry();
    const profileReg = new ProfileRegistry();
    profileReg.addFileProfile('default', { tools: ['*'] });
    const svc = new ProfileService(profileReg, toolReg);
    const app = createMcpExpressApp(svc, toolReg, new Map(), [], {
      lookupProfileByToken: lookup,
    });
    return createServer(app);
  }

  async function listen(s: ReturnType<typeof createServer>): Promise<void> {
    server = s;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  }

  async function post(headers: Record<string, string>, query = ''): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/mcp${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
  }

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  });

  it('rejects an unknown bearer with 401 and does not fall back to ?profile=', async () => {
    await listen(build(() => null));
    const res = await post({ Authorization: 'Bearer nope' }, '?profile=default');
    expect(res.status).toBe(401);
    expect((await res.json() as Record<string, unknown>)['error']).toBe('invalid_profile_token');
  });

  it('accepts a known bearer — binding proceeds (no 401)', async () => {
    await listen(build(t => (t === 'good' ? 'default' : null)));
    const res = await post({ Authorization: 'Bearer good' });
    expect(res.status).not.toBe(401);
  });

  it('keeps the legacy path when no bearer is present (no 401)', async () => {
    await listen(build(() => null));
    const res = await post({}, '?profile=default');
    expect(res.status).not.toBe(401);
  });
});
