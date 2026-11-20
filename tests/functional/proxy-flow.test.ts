import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpProxyDriver } from '../../src/adapters/outbound/drivers/mcp-proxy.js';
import { createHarness, type Harness } from './harness.js';
import { createStubUpstream, type StubUpstream } from './stub-upstream.js';
import type { McpProxyToolConfig } from '../../src/config/types.js';

function makeProxyConfig(name: string, stub: StubUpstream): McpProxyToolConfig {
  return {
    type: 'mcp_proxy',
    name,
    service_dns: stub.host,
    port: stub.port,
    refresh_interval_ms: 600_000,
  };
}

describe('Proxy flow — tool listing', () => {
  let h: Harness;
  let stub: StubUpstream;

  beforeEach(async () => {
    stub = await createStubUpstream([
      { name: 'read_secret', description: 'Read a Vault secret', response: 'value' },
      { name: 'list_secrets', description: 'List Vault secrets', response: '[]' },
    ]);
    const config = makeProxyConfig('vault', stub);
    const driver = new McpProxyDriver(config, stub.host);
    await driver.connect();

    h = await createHarness({
      config: { profiles: { default: { tools: ['*'] } } },
      proxyDrivers: new Map([['vault', driver]]),
    });
    h.profileRegistry.addFileProfile('default', { tools: ['*'] });
    for (const def of driver.getToolDefs()) {
      h.toolRegistry.addFileTool({
        id: def.name,
        driver: 'mcp_proxy',
        source: 'file',
        config,
        mcpDef: def,
      });
    }
  });

  afterEach(async () => {
    await h.teardown();
    await stub.teardown();
  });

  it('lists namespaced tools from upstream', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.mcpPort}/mcp`));
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('vault__read_secret');
      expect(names).toContain('vault__list_secrets');
    } finally {
      await client.close();
    }
  });

  it('exposes upstream tool descriptions unchanged', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.mcpPort}/mcp`));
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      const readSecret = tools.find(t => t.name === 'vault__read_secret');
      expect(readSecret?.description).toBe('Read a Vault secret');
    } finally {
      await client.close();
    }
  });

  it('filters tools by profile — example profile sees only vault__*', async () => {
    const grafanaStub = await createStubUpstream([
      { name: 'query_prometheus', description: 'Query Prometheus', response: '{}' },
    ]);
    const grafanaConfig = makeProxyConfig('grafana', grafanaStub);
    const grafanaDriver = new McpProxyDriver(grafanaConfig, grafanaStub.host);
    await grafanaDriver.connect();

    const vaultStub2 = await createStubUpstream([
      { name: 'read_secret', description: 'Read a Vault secret', response: 'value' },
    ]);
    const vaultConfig2 = makeProxyConfig('vault', vaultStub2);
    const vaultDriver2 = new McpProxyDriver(vaultConfig2, vaultStub2.host);
    await vaultDriver2.connect();

    const localH = await createHarness({
      config: { profiles: { example: { tools: ['vault__*'] } } },
      proxyDrivers: new Map([['vault', vaultDriver2], ['grafana', grafanaDriver]]),
    });
    localH.profileRegistry.addFileProfile('example', { tools: ['vault__*'] });

    for (const def of vaultDriver2.getToolDefs()) {
      localH.toolRegistry.addFileTool({
        id: def.name,
        driver: 'mcp_proxy',
        source: 'file',
        config: vaultConfig2,
        mcpDef: def,
      });
    }
    for (const def of grafanaDriver.getToolDefs()) {
      localH.toolRegistry.addFileTool({
        id: def.name,
        driver: 'mcp_proxy',
        source: 'file',
        config: grafanaConfig,
        mcpDef: def,
      });
    }

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${localH.mcpPort}/mcp?profile=example`));
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('vault__read_secret');
      expect(names.some(n => n.startsWith('grafana__'))).toBe(false);
    } finally {
      await client.close();
      await localH.teardown();
      await grafanaStub.teardown();
      await vaultStub2.teardown();
    }
  });
});

describe('Proxy flow — tool calling', () => {
  let h: Harness;
  let stub: StubUpstream;
  let driver: McpProxyDriver;

  beforeEach(async () => {
    stub = await createStubUpstream([
      { name: 'read_secret', description: 'Read a Vault secret', response: 'super-secret' },
    ]);
    const config = makeProxyConfig('vault', stub);
    driver = new McpProxyDriver(config, stub.host);
    await driver.connect();

    h = await createHarness({
      config: { profiles: { default: { tools: ['*'] } } },
      proxyDrivers: new Map([['vault', driver]]),
    });
    h.profileRegistry.addFileProfile('default', { tools: ['*'] });
    for (const def of driver.getToolDefs()) {
      h.toolRegistry.addFileTool({
        id: def.name,
        driver: 'mcp_proxy',
        source: 'file',
        config,
        mcpDef: def,
      });
    }
  });

  afterEach(async () => {
    await h.teardown();
    await stub.teardown();
  });

  it('calls upstream tool and returns response', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.mcpPort}/mcp`));
    await client.connect(transport);

    try {
      const result = await client.callTool({ name: 'vault__read_secret', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]).toEqual({ type: 'text', text: 'super-secret' });
    } finally {
      await client.close();
    }
  });

  it('returns isError for unknown namespaced tool', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.mcpPort}/mcp`));
    await client.connect(transport);

    try {
      const result = await client.callTool({ name: 'vault__nonexistent', arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('returns isError for call to unknown proxy namespace', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.mcpPort}/mcp`));
    await client.connect(transport);

    try {
      const result = await client.callTool({ name: 'grafana__query_prometheus', arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('Proxy flow — response handling', () => {
  let h: Harness;
  let stub: StubUpstream;

  beforeEach(async () => {
    stub = await createStubUpstream([
      { name: 'get_data', description: 'Get data', response: '{"key":"value"}' },
    ]);
    const config = makeProxyConfig('myapi', stub);
    const driver = new McpProxyDriver(config, stub.host);
    await driver.connect();

    h = await createHarness({
      config: { profiles: { default: { tools: ['*'] } } },
      proxyDrivers: new Map([['myapi', driver]]),
    });
    h.profileRegistry.addFileProfile('default', { tools: ['*'] });
    for (const def of driver.getToolDefs()) {
      h.toolRegistry.addFileTool({
        id: def.name,
        driver: 'mcp_proxy',
        source: 'file',
        config,
        mcpDef: def,
      });
    }
  });

  afterEach(async () => {
    await h.teardown();
    await stub.teardown();
  });

  it('passes response content through unchanged', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${h.mcpPort}/mcp`));
    await client.connect(transport);

    try {
      const result = await client.callTool({ name: 'myapi__get_data', arguments: {} });
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: 'text', text: '{"key":"value"}' });
    } finally {
      await client.close();
    }
  });
});
