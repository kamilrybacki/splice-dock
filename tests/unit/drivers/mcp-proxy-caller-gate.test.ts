import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpProxyToolConfig } from '../../../src/config/types.js';
import { runWithCaller } from '../../../src/common/request/context.js';
import { unusedBroker } from '../../helpers/broker.js';

interface SeenTarget { authenticated: boolean; tokenId: string | null }
const state = vi.hoisted(() => ({ calls: 0, resolves: 0, targets: [] as SeenTarget[] }));

vi.mock('../../../src/services/secrets/adapters/resolution.js', () => ({
  resolveCredentialSource: async (_source: unknown, target: SeenTarget) => {
    state.resolves += 1;
    state.targets.push({ authenticated: target.authenticated, tokenId: target.tokenId });
    return 'tok';
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(): Promise<void> {}
    async listTools(): Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }> {
      return { tools: [{ name: 'read_secret', inputSchema: { type: 'object' } }] };
    }
    async callTool(): Promise<unknown> {
      state.calls += 1;
      return { content: [{ type: 'text', text: 'ok' }] };
    }
    async close(): Promise<void> {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class { async close(): Promise<void> {} },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {},
}));

const { McpProxyDriver } = await import('../../../src/services/upstreams/adapters/mcp/driver.js');

function makeConfig(auth: McpProxyToolConfig['auth']): McpProxyToolConfig {
  return {
    type: 'mcp_proxy',
    name: 'vault',
    service_dns: 'vault-mcp-headless.mcp-servers.svc.cluster.local',
    port: 8000,
    transport: 'streamable_http',
    refresh_interval_ms: 600_000,
    auth,
  };
}

const builder = { profile: 'worker', agent: null, authenticated: true, tokenId: 'tid-a' };
const authed = { profile: 'worker', tokenId: 'tid-b', authenticated: true };
const anonymous = { profile: 'worker', tokenId: 'legacy-query', authenticated: false };
const MINTED_BEARER = { type: 'bearer' as const, token: { mint: 'vault_token' } };

// A proxy driver is shared across sessions, so the identity it was built with
// says nothing about the caller of a later request. Each call is checked.
describe('McpProxyDriver — minted auth requires an authenticated caller per call', () => {
  beforeEach(() => {
    state.calls = 0;
    state.resolves = 0;
    state.targets.length = 0;
  });

  it('allows an authenticated caller on a driver built by another authenticated caller', async () => {
    const driver = new McpProxyDriver(makeConfig(MINTED_BEARER), unusedBroker(), undefined, builder);
    await driver.connect();
    const result = await runWithCaller(authed, () => driver.callTool('vault__read_secret', {}));
    expect(result.isError).toBeFalsy();
    expect(state.calls).toBe(1);
  });

  it('refuses an unauthenticated caller on a shared minted-auth driver', async () => {
    const driver = new McpProxyDriver(makeConfig(MINTED_BEARER), unusedBroker(), undefined, builder);
    await driver.connect();
    const resolvesAfterConnect = state.resolves;
    await expect(runWithCaller(anonymous, () => driver.callTool('vault__read_secret', {})))
      .rejects.toThrow('credential_identity_unauthenticated');
    expect(state.calls).toBe(0);
    expect(state.resolves).toBe(resolvesAfterConnect);
  });

  it('refuses a call with no caller context on a minted-auth driver', async () => {
    const driver = new McpProxyDriver(makeConfig({ type: 'header', name: 'X-Token', value: { mint: 'vault_token' } }), unusedBroker(), undefined, builder);
    await driver.connect();
    await expect(driver.callTool('vault__read_secret', {})).rejects.toThrow('credential_identity_unauthenticated');
    expect(state.calls).toBe(0);
  });

  it('refuses an unauthenticated caller on the reviewed (Code Mode) path', async () => {
    const driver = new McpProxyDriver(makeConfig(MINTED_BEARER), unusedBroker(), undefined, builder);
    await driver.connect();
    const exchange = {} as Parameters<typeof driver.callReviewedTool>[2];
    await expect(runWithCaller(anonymous, () =>
      driver.callReviewedTool('vault__read_secret', {}, exchange, new AbortController().signal),
    )).rejects.toThrow('credential_identity_unauthenticated');
    expect(state.calls).toBe(0);
  });

  it('keeps static operator credentials available to unauthenticated callers', async () => {
    const driver = new McpProxyDriver(makeConfig({ type: 'bearer', token: { from: 'env:VAULT_TOKEN' } }), unusedBroker(), undefined, builder);
    await driver.connect();
    const result = await runWithCaller(anonymous, () => driver.callTool('vault__read_secret', {}));
    expect(result.isError).toBeFalsy();
    expect(state.calls).toBe(1);
  });

  it('attributes a mint to the current caller, not the caller that built the driver', async () => {
    const driver = new McpProxyDriver(makeConfig(MINTED_BEARER), unusedBroker(), undefined, builder);
    await driver.connect();
    state.targets.length = 0;
    await runWithCaller(authed, () => driver.callTool('vault__read_secret', {}));
    expect(state.targets.length).toBeGreaterThan(0);
    for (const seen of state.targets) expect(seen).toEqual({ authenticated: true, tokenId: 'tid-b' });
  });

  it('attributes a connect under a caller context to that caller', async () => {
    const driver = new McpProxyDriver(makeConfig(MINTED_BEARER), unusedBroker(), undefined, builder);
    await runWithCaller(authed, () => driver.connect());
    expect(state.targets.length).toBeGreaterThan(0);
    for (const seen of state.targets) expect(seen).toEqual({ authenticated: true, tokenId: 'tid-b' });
  });

  it('falls back to the identity the driver was built with when there is no caller context', async () => {
    const driver = new McpProxyDriver(makeConfig(MINTED_BEARER), unusedBroker(), undefined, builder);
    await driver.connect();
    expect(state.targets.length).toBeGreaterThan(0);
    for (const seen of state.targets) expect(seen).toEqual({ authenticated: true, tokenId: 'tid-a' });
  });
});
