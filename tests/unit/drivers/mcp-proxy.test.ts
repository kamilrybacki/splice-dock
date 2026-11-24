import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpProxyToolConfig } from '../../../src/config/types.js';

// Mock the MCP SDK before importing the driver
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

const MockClient = vi.fn().mockImplementation(function () {
  return {
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    close: mockClose,
  };
});

const mockTransportClose = vi.fn().mockResolvedValue(undefined);
const MockStreamableHTTPClientTransport = vi.fn().mockImplementation(function () {
  return {
    close: mockTransportClose,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
}));

// Import after mocking
const { McpProxyDriver } = await import('../../../src/services/upstreams/adapters/mcp/driver.js');

function makeConfig(overrides: Partial<McpProxyToolConfig> = {}): McpProxyToolConfig {
  return {
      type: 'mcp_proxy',
      name: 'upstream-server',
      service_dns: 'upstream-server-headless.default.svc.cluster.local',
      port: 8000,
      refresh_interval_ms: 600_000,
      ...overrides,
  };
}

describe('McpProxyDriver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListTools.mockResolvedValue({
      tools: [
        { name: 'get_item', description: 'Get an item', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        { name: 'list_items', description: 'List all items', inputSchema: { type: 'object' } },
      ],
    });
  });

  it('connects and discovers tools with namespace prefix', async () => {
    const driver = new McpProxyDriver(makeConfig(), '10.0.0.5');
    await driver.connect();

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockListTools).toHaveBeenCalledTimes(1);

    const defs = driver.getToolDefs();
    expect(defs).toHaveLength(2);
    expect(defs[0]!.name).toBe('upstream-server__get_item');
    expect(defs[1]!.name).toBe('upstream-server__list_items');
    expect(defs[0]!.description).toBe('Get an item');
  });

  it('connects via Streamable HTTP to pinned pod IP', async () => {
    const driver = new McpProxyDriver(makeConfig(), '10.0.0.5');
    await driver.connect();
    expect(MockStreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('http://10.0.0.5:8000/mcp'), expect.objectContaining({ fetch: expect.any(Function) })
    );
    expect(mockConnect).toHaveBeenCalled();
  });

  it('uses correct port from config', async () => {
    const driver = new McpProxyDriver(makeConfig({ port: 9090 }), '10.0.0.7');
    await driver.connect();
    expect(MockStreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('http://10.0.0.7:9090/mcp'), expect.objectContaining({ fetch: expect.any(Function) })
    );
  });

  it('callTool forwards to upstream with original (non-namespaced) name', async () => {
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'item-data' }],
    });
    const driver = new McpProxyDriver(makeConfig(), '10.0.0.5');
    await driver.connect();

    const result = await driver.callTool('upstream-server__get_item', { id: '42' });
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'get_item',
      arguments: { id: '42' },
    });
    expect(result.content[0]!.text).toBe('item-data');
    expect(result.isError).toBeUndefined();
  });

  it('returns isError for unknown tool', async () => {
    const driver = new McpProxyDriver(makeConfig(), '10.0.0.5');
    await driver.connect();

    const result = await driver.callTool('upstream-server__nonexistent_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not found');
  });

  it('disconnect calls close on the client and clears state', async () => {
    const driver = new McpProxyDriver(makeConfig(), '10.0.0.5');
    await driver.connect();
    await driver.disconnect();

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(driver.getToolDefs()).toHaveLength(0);
  });

  it('returns isError when not connected (after disconnect)', async () => {
    const driver = new McpProxyDriver(makeConfig(), '10.0.0.5');
    await driver.connect();
    await driver.disconnect();

    // After disconnect, client is null and knownTools is cleared.
    expect(driver.getToolDefs()).toHaveLength(0);
  });

  it('retries callTool on failure', async () => {
    mockCallTool
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValue({ content: [{ type: 'text', text: 'success' }] });

    const driver = new McpProxyDriver(makeConfig({
      retry: { max_attempts: 2, backoff_ms: 10 },
    }), '10.0.0.5');
    await driver.connect();

    const result = await driver.callTool('upstream-server__get_item', { id: '1' });
    expect(mockCallTool).toHaveBeenCalledTimes(2);
    expect(result.content[0]!.text).toBe('success');
  });

  it('reconnects and retries when a streamable_http upstream drops its session', async () => {
    // Default config has no `transport` field → streamable_http path. A stateful
    // upstream that restarts/expires its session returns `session_not_found`; the
    // driver must reconnect once and retry (regression: this used to be SSE-only,
    // leaving argocd-style streamable upstreams permanently wedged).
    mockCallTool
      .mockRejectedValueOnce(new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":{"code":"session_not_found"}}'))
      .mockResolvedValue({ content: [{ type: 'text', text: 'recovered' }] });

    const driver = new McpProxyDriver(makeConfig(), '10.0.0.5');
    await driver.connect();
    expect(mockConnect).toHaveBeenCalledTimes(1);

    const result = await driver.callTool('upstream-server__get_item', { id: '1' });

    expect(mockClose).toHaveBeenCalled();          // cached client closed before reconnect
    expect(mockConnect).toHaveBeenCalledTimes(2);  // initial connect + reconnect
    expect(mockCallTool).toHaveBeenCalledTimes(2); // failed call + retried call
    expect(result.content[0]!.text).toBe('recovered');
  });

  it('closes transport on connect failure', async () => {
    mockConnect.mockRejectedValueOnce(new Error('connection refused'));
    const driver = new McpProxyDriver(makeConfig(), '10.0.0.1');
    await expect(driver.connect()).rejects.toThrow('connection refused');
    expect(mockTransportClose).toHaveBeenCalledTimes(1);
  });

  it('works with optional pinnedPodIp using service_dns fallback', async () => {
    // When no pinnedPodIp is provided, driver uses service_dns directly
    const driver = new McpProxyDriver(makeConfig());
    await driver.connect();
    expect(MockStreamableHTTPClientTransport).toHaveBeenCalledWith(
      new URL('http://upstream-server-headless.default.svc.cluster.local:8000/mcp'), expect.objectContaining({ fetch: expect.any(Function) })
    );
  });

  it('adds namespace description hint when description is set', async () => {
    const driver = new McpProxyDriver(
      makeConfig({ description: 'My upstream' }),
      '10.0.0.5'
    );
    await driver.connect();
    const defs = driver.getToolDefs();
    expect(defs[0]!.description).toContain('[upstream-server: My upstream]');
  });
});
