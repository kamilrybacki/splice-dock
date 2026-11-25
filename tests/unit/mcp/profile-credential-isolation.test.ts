import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileService } from '../../../src/services/profiles/base.js';
import { ToolRegistry } from '../../../src/services/tools/registry.js';
import { ProfileRegistry } from '../../../src/services/profiles/registry.js';
import type { McpProxyDriver } from '../../../src/services/upstreams/adapters/mcp/driver.js';
import type { McpProxyToolConfig } from '../../../src/config/types.js';
import { unusedBroker } from '../../helpers/broker.js';

const handlers = new Map<string, (req: unknown) => unknown>();
const built = vi.hoisted(() => ({ configs: [] as Array<{ name: string; auth?: unknown }>, connectError: null as Error | null }));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn().mockImplementation(function () {
    return {
      setRequestHandler: vi.fn((schema: string, handler: (req: unknown) => unknown) => {
        handlers.set(schema, handler);
      }),
      connect: vi.fn(),
      getClientVersion: vi.fn(() => undefined),
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema: 'ListToolsRequestSchema',
  CallToolRequestSchema: 'CallToolRequestSchema',
}));

vi.mock('@modelcontextprotocol/sdk/server/sse.js', () => ({
  SSEServerTransport: vi.fn(),
}));

vi.mock('../../../src/services/upstreams/adapters/mcp/driver.js', () => ({
  proxyDriverKey: (namespace: string, identity?: { profile: string; agent: string | null }) =>
    identity === undefined
      ? namespace
      : `${namespace}\u0000${identity.profile}\u0000${identity.agent === null ? '0' : `1${identity.agent}`}`,
  proxyDriverNamespace: (key: string) => key.split('\u0000')[0],
  McpProxyDriver: class {
    constructor(public readonly config: { name: string; auth?: unknown }) {
      built.configs.push(config);
    }
    async connect(): Promise<void> {
      if (built.connectError) throw built.connectError;
    }
    async callTool(): Promise<unknown> {
      return { content: [{ type: 'text', text: 'ok' }] };
    }
  },
}));

const { buildMcpServer } = await import('../../../src/services/mcp/adapters/express/server.js');

const BASE_AUTH = { type: 'bearer' as const, token: { from: 'env:BASE_TOKEN' } };
const WORKER_AUTH = { type: 'bearer' as const, token: { from: 'env:WORKER_TOKEN' } };

function makeProxyConfig(): McpProxyToolConfig {
  return {
    type: 'mcp_proxy',
    name: 'vault',
    service_dns: 'vault-headless.default.svc.cluster.local',
    port: 8000,
    transport: 'streamable_http',
    refresh_interval_ms: 600_000,
    auth: BASE_AUTH,
  };
}

function makeRegistry(): { profileService: ProfileService; toolRegistry: ToolRegistry } {
  const toolRegistry = new ToolRegistry();
  const proxyConfig = makeProxyConfig();
  toolRegistry.addFileTool({
    id: 'vault__read_secret',
    driver: 'mcp_proxy',
    source: 'file',
    config: proxyConfig,
    mcpDef: { name: 'vault__read_secret', description: 'read', inputSchema: { type: 'object' as const } },
  });
  const profileRegistry = new ProfileRegistry();
  profileRegistry.addFileProfile('worker', { tools: ['vault__*'] });
  profileRegistry.addFileProfile('plain', { tools: ['vault__*'] });
  return { profileService: new ProfileService(profileRegistry, toolRegistry), toolRegistry };
}

function callHandler(): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  const handler = handlers.get('CallToolRequestSchema') as (
    req: unknown,
    extra: unknown,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  return handler({ params: { name: 'vault__read_secret', arguments: {} } }, { signal: undefined });
}

const resolver = { resolve: async () => ['10.0.0.1'] } as never;

function build(profile: string, drivers: Map<string, McpProxyDriver>, profileAuth = (p: string, backend: string) =>
  p === 'worker' && backend === 'vault' ? WORKER_AUTH : undefined, agent: string | null = null) {
  const { profileService, toolRegistry } = makeRegistry();
  buildMcpServer(
    profile,
    profileService,
    drivers,
    toolRegistry,
    [],
    [makeProxyConfig()],
    resolver,
    agent,
    undefined,
    profileAuth, unusedBroker());
}

describe('per-profile mcp_proxy credentials', () => {
  beforeEach(() => {
    handlers.clear();
    built.configs.length = 0;
    built.connectError = null;
  });

  it('gives a profile with an override its own driver and credential', async () => {
    const drivers = new Map<string, McpProxyDriver>();
    build('worker', drivers);

    await callHandler();

    expect(drivers.has('vault\u0000worker\u00000')).toBe(true);
    expect(drivers.has('vault')).toBe(false);
    expect(built.configs).toHaveLength(1);
    expect(built.configs[0]!.auth).toEqual(WORKER_AUTH);
  });

  it('keeps the shared tool-level credential for profiles without an override', async () => {
    const drivers = new Map<string, McpProxyDriver>();
    build('plain', drivers);

    await callHandler();

    expect(drivers.has('vault')).toBe(true);
    expect(built.configs[0]!.auth).toEqual(BASE_AUTH);
  });

  it('never sends one profile\'s credential to another profile', async () => {
    const drivers = new Map<string, McpProxyDriver>();
    build('worker', drivers);
    await callHandler();
    build('plain', drivers);
    await callHandler();

    expect(built.configs.map(c => c.auth)).toEqual([WORKER_AUTH, BASE_AUTH]);
    expect(drivers.has('vault\u0000worker\u00000')).toBe(true);
    expect(drivers.has('vault')).toBe(true);
  });

  it('gives each agent of one profile its own driver', async () => {
    const drivers = new Map<string, McpProxyDriver>();
    build('worker', drivers, undefined, 'builder');
    await callHandler();
    build('worker', drivers, undefined, 'reviewer');
    await callHandler();

    expect(built.configs).toHaveLength(2);
    expect(drivers.has('vault\u0000worker\u00001builder')).toBe(true);
    expect(drivers.has('vault\u0000worker\u00001reviewer')).toBe(true);
    expect(drivers.size).toBe(2);
  });

  it('does not reuse the driver of an agent named "_" for a caller without an agent', async () => {
    const drivers = new Map<string, McpProxyDriver>();
    build('worker', drivers, undefined, '_');
    await callHandler();
    build('worker', drivers, undefined, null);
    await callHandler();

    expect(built.configs).toHaveLength(2);
    expect(drivers.size).toBe(2);
  });

  it('reuses an already-open profile-scoped connection', async () => {
    const drivers = new Map<string, McpProxyDriver>();
    build('worker', drivers);
    await callHandler();
    await callHandler();

    expect(built.configs).toHaveLength(1);
  });

  it('fails closed instead of falling back to a shared driver when it cannot honour the override', async () => {
    const shared = { callTool: vi.fn() } as unknown as McpProxyDriver;
    const drivers = new Map<string, McpProxyDriver>([['vault', shared]]);

    // No proxyConfigs / resolver: an override cannot open its own connection.
    const { profileService, toolRegistry } = makeRegistry();
    buildMcpServer(
      'worker',
      profileService,
      drivers,
      toolRegistry,
      [],
      undefined,
      undefined,
      null,
      undefined,
      () => WORKER_AUTH, unusedBroker());

    await expect(callHandler()).rejects.toThrow(/No proxy driver/);
    expect(shared.callTool).not.toHaveBeenCalled();
  });

  it('surfaces an identity refusal from the lazy connect instead of hiding it', async () => {
    built.connectError = new Error('credential_identity_unauthenticated');
    const drivers = new Map<string, McpProxyDriver>();
    build('worker', drivers);

    await expect(callHandler()).rejects.toThrow('credential_identity_unauthenticated');
    expect(drivers.size).toBe(0);
  });

  it('still reports a missing driver when the lazy connect fails for another reason', async () => {
    built.connectError = new Error('ECONNREFUSED');
    const drivers = new Map<string, McpProxyDriver>();
    build('worker', drivers);

    await expect(callHandler()).rejects.toThrow(/No proxy driver/);
  });
});
