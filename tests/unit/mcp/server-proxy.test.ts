import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileService } from '../../../src/services/profiles/base.js';
import { ToolRegistry } from '../../../src/services/tools/tool-registry.js';
import { ProfileRegistry } from '../../../src/services/profiles/profile-registry.js';
import type { McpProxyToolConfig } from '../../../src/config/types.js';

// Capture setRequestHandler callbacks so we can invoke them directly
const handlers = new Map<string, (req: unknown) => unknown>();

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

// Import after mocking
const { buildMcpServer } = await import('../../../src/services/mcp/adapters/express/server.js');

// ─── helpers ────────────────────────────────────────────────────────────────

function makeProxyConfig(name: string): McpProxyToolConfig {
  return { type: 'mcp_proxy', name, service_dns: `${name}-headless.default.svc.cluster.local`, port: 8000, refresh_interval_ms: 600_000 };
}

function makeProxyRegistryEntry(namespacedName: string, driverName: string) {
  return {
      id: namespacedName,
      driver: 'mcp_proxy' as const,
      source: 'file' as const,
      config: makeProxyConfig(driverName),
      mcpDef: {
        name: namespacedName,
        description: `Tool ${namespacedName}`,
        inputSchema: { type: 'object' as const },
      },
  };
}

// ─── multi-proxy tool listing ────────────────────────────────────────────────

describe('buildMcpServer — multi-proxy tool listing', () => {
  let profileService: ProfileService;
  let toolReg: ToolRegistry;
  let profileReg: ProfileRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();

    toolReg = new ToolRegistry();
    profileReg = new ProfileRegistry();

    // Register tools from two different proxy drivers
    toolReg.addFileTool(makeProxyRegistryEntry('alpha__search', 'alpha'));
    toolReg.addFileTool(makeProxyRegistryEntry('alpha__create', 'alpha'));
    toolReg.addFileTool(makeProxyRegistryEntry('beta__list', 'beta'));

    // Profile that allows all tools from both drivers
    profileReg.addFileProfile('multi', { tools: ['alpha__*', 'beta__*'] });

    profileService = new ProfileService(profileReg, toolReg);
  });

  it('aggregates tools from all connected proxy drivers', () => {
    const driverAlpha = { callTool: vi.fn() };
    const driverBeta = { callTool: vi.fn() };
    const proxyDrivers = new Map([
      ['alpha', driverAlpha],
      ['beta', driverBeta],
    ]);

    buildMcpServer('multi', profileService, proxyDrivers as never, toolReg);

    const listHandler = handlers.get('ListToolsRequestSchema') as () => Promise<{ tools: unknown[] }>;
    expect(listHandler).toBeDefined();

    return listHandler().then(({ tools }) => {
      expect(tools).toHaveLength(3);
      const names = (tools as Array<{ name: string }>).map(t => t.name);
      expect(names).toContain('alpha__search');
      expect(names).toContain('alpha__create');
      expect(names).toContain('beta__list');
    });
  });

  it('namespaces tools with driver name prefix', () => {
    const proxyDrivers = new Map([
      ['alpha', { callTool: vi.fn() }],
      ['beta', { callTool: vi.fn() }],
    ]);

    buildMcpServer('multi', profileService, proxyDrivers as never, toolReg);

    const listHandler = handlers.get('ListToolsRequestSchema') as () => Promise<{ tools: unknown[] }>;

    return listHandler().then(({ tools }) => {
      const names = (tools as Array<{ name: string }>).map(t => t.name);
      for (const name of names) {
        expect(name).toMatch(/^(alpha|beta)__/);
      }
    });
  });

  it('filters proxied tools by profile glob', () => {
    // Add a tool that should NOT appear for this profile
    toolReg.addFileTool(makeProxyRegistryEntry('gamma__delete', 'gamma'));
    profileReg.addFileProfile('alpha-only', { tools: ['alpha__*'] });
    const alphaOnlyService = new ProfileService(profileReg, toolReg);

    const proxyDrivers = new Map([
      ['alpha', { callTool: vi.fn() }],
      ['beta', { callTool: vi.fn() }],
      ['gamma', { callTool: vi.fn() }],
    ]);

    buildMcpServer('alpha-only', alphaOnlyService, proxyDrivers as never, toolReg);

    const listHandler = handlers.get('ListToolsRequestSchema') as () => Promise<{ tools: unknown[] }>;

    return listHandler().then(({ tools }) => {
      const names = (tools as Array<{ name: string }>).map(t => t.name);
      expect(names).toContain('alpha__search');
      expect(names).toContain('alpha__create');
      expect(names).not.toContain('beta__list');
      expect(names).not.toContain('gamma__delete');
    });
  });
});

// ─── call routing ────────────────────────────────────────────────────────────

describe('buildMcpServer — call routing', () => {
  let profileService: ProfileService;
  let toolReg: ToolRegistry;
  let profileReg: ProfileRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();

    toolReg = new ToolRegistry();
    profileReg = new ProfileRegistry();

    toolReg.addFileTool(makeProxyRegistryEntry('alpha__search', 'alpha'));
    toolReg.addFileTool(makeProxyRegistryEntry('beta__list', 'beta'));

    profileReg.addFileProfile('routing', { tools: ['alpha__*', 'beta__*'] });

    profileService = new ProfileService(profileReg, toolReg);
  });

  it('routes tool calls to the correct proxy driver', async () => {
    const driverAlpha = { callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'alpha result' }] }) };
    const driverBeta = { callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'beta result' }] }) };
    const proxyDrivers = new Map([
      ['alpha', driverAlpha],
      ['beta', driverBeta],
    ]);

    buildMcpServer('routing', profileService, proxyDrivers as never, toolReg);

    const callHandler = handlers.get('CallToolRequestSchema') as (req: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

    // Call alpha tool
    const alphaResult = await callHandler({ params: { name: 'alpha__search', arguments: { q: 'test' } } });
    expect(driverAlpha.callTool).toHaveBeenCalledWith('alpha__search', { q: 'test' });
    expect(driverBeta.callTool).not.toHaveBeenCalled();
    expect(alphaResult.content[0].text).toBe('alpha result');
    expect(alphaResult.isError).toBeUndefined();

    // Reset and call beta tool
    vi.clearAllMocks();
    const betaResult = await callHandler({ params: { name: 'beta__list', arguments: {} } });
    expect(driverBeta.callTool).toHaveBeenCalledWith('beta__list', {});
    expect(driverAlpha.callTool).not.toHaveBeenCalled();
    expect(betaResult.content[0].text).toBe('beta result');
    expect(betaResult.isError).toBeUndefined();
  });

  it('returns isError for tool not found on any proxy', async () => {
    const proxyDrivers = new Map([
      ['alpha', { callTool: vi.fn() }],
      ['beta', { callTool: vi.fn() }],
    ]);

    buildMcpServer('routing', profileService, proxyDrivers as never, toolReg);

    const callHandler = handlers.get('CallToolRequestSchema') as (req: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

    // Tool name not matching any profile glob → rejected before registry lookup
    const result = await callHandler({ params: { name: 'unknown__tool', arguments: {} } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('returns isError when tool is allowed but driver is missing from proxyDrivers map', async () => {
    // proxyDrivers map is empty — alpha__search is in registry and profile allows it,
    // but there is no driver for the 'alpha' namespace
    buildMcpServer('routing', profileService, new Map(), toolReg);
    const callHandler = handlers.get('CallToolRequestSchema') as (req: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
    await expect(callHandler({ params: { name: 'alpha__search', arguments: {} } })).rejects.toThrow(/alpha/i);
  });

  it('returns isError when tool passes profile check but is not in registry', async () => {
    // alpha__purge matches the profile glob alpha__* but was never registered in toolReg
    const driverAlpha = { callTool: vi.fn() };
    buildMcpServer('routing', profileService, new Map([['alpha', driverAlpha]]) as never, toolReg);
    const callHandler = handlers.get('CallToolRequestSchema') as (req: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
    const result = await callHandler({ params: { name: 'alpha__purge', arguments: {} } });
    expect(result.isError).toBe(true);
  });
});
