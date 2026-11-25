import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpProxyToolConfig } from '../../../src/config/types.js';
import { runWithCaller } from '../../../src/common/request/context.js';
import { unusedBroker } from '../../helpers/broker.js';

const state = vi.hoisted(() => ({ token: 'tok-1', connects: 0, calls: 0 }));

vi.mock('../../../src/services/secrets/adapters/resolution.js', () => ({
  resolveCredentialSource: async () => state.token,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(): Promise<void> { state.connects += 1; }
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

const identity = { profile: 'worker', agent: null, authenticated: true, tokenId: 'tid' };
const caller = { profile: 'worker', tokenId: 'tid', authenticated: true };

describe('McpProxyDriver — minted credential rotation', () => {
  beforeEach(() => {
    state.token = 'tok-1';
    state.connects = 0;
    state.calls = 0;
  });

  it('re-opens the session when the minted credential changes', async () => {
    const driver = new McpProxyDriver(makeConfig({ type: 'bearer', token: { mint: 'vault_token' } }), unusedBroker(), undefined, identity);
    await driver.connect();
    expect(state.connects).toBe(1);

    await runWithCaller(caller, () => driver.callTool('vault__read_secret', {}));
    expect(state.connects).toBe(1);

    state.token = 'tok-2';
    await runWithCaller(caller, () => driver.callTool('vault__read_secret', {}));
    expect(state.connects).toBe(2);
    expect(state.calls).toBe(2);
  });

  it('never re-opens the session for a static credential', async () => {
    const driver = new McpProxyDriver(makeConfig({ type: 'bearer', token: { from: 'env:VAULT_TOKEN' } }), unusedBroker(), undefined, identity);
    await driver.connect();
    state.token = 'tok-2';
    await runWithCaller(caller, () => driver.callTool('vault__read_secret', {}));
    expect(state.connects).toBe(1);
  });
});
