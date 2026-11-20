import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerToolRoutes } from '../../../src/adapters/inbound/admin/routes/tools.js';
import { ToolRegistry } from '../../../src/application/registry/tool-registry.js';
import { ToolService } from '../../../src/application/tools/tool-service.js';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';

const httpBody = {
  type: 'http', name: 'get_user', namespace: 'myapi', description: 'Get a user',
  method: 'GET', url: 'https://api.example.com/users/{id}',
  params: [{ name: 'id', in: 'path', required: true }], auth: { type: 'none' },
};

describe('tool routes persist runtime tools to the store', () => {
  let app: FastifyInstance;
  let registry: ToolRegistry;
  let store: SplicedockStore;

  beforeEach(async () => {
    registry = new ToolRegistry();
    const service = new ToolService(registry);
    store = await SplicedockStore.open(':memory:');
    app = Fastify({ logger: false });
    registerToolRoutes(app, registry, service, store);
    await app.ready();
  });
  afterEach(async () => { await app.close(); await store.close(); });

  it('POST persists the tool to runtime_tools', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/tools', payload: httpBody });
    expect(res.statusCode).toBe(201);
    const rows = await store.listRuntimeTools();
    expect(rows.map(r => r.id)).toEqual(['myapi__get_user']);
    expect(rows[0].driver).toBe('http');
  });

  it('mcp_proxy is rejected and never persisted', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/tools',
      payload: { type: 'mcp_proxy', name: 'vault', service_dns: 'vault.svc', port: 8000 },
    });
    expect(res.statusCode).toBe(400);
    expect(await store.listRuntimeTools()).toEqual([]);
  });

  it('DELETE removes the persisted row', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/tools', payload: httpBody });
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/tools/myapi__get_user' });
    expect(del.statusCode).toBe(204);
    expect(await store.listRuntimeTools()).toEqual([]);
  });

  it('PUT updates the persisted config', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/tools', payload: httpBody });
    const put = await app.inject({
      method: 'PUT', url: '/api/v1/tools/myapi__get_user',
      payload: { ...httpBody, description: 'Updated' },
    });
    expect(put.statusCode).toBe(200);
    const rows = await store.listRuntimeTools();
    expect((rows[0].config as { description: string }).description).toBe('Updated');
  });

  it('PUT rejects a rename (body id != path id)', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/tools', payload: httpBody });
    const put = await app.inject({
      method: 'PUT', url: '/api/v1/tools/myapi__get_user',
      payload: { ...httpBody, name: 'renamed' }, // -> myapi__renamed != path
    });
    expect(put.statusCode).toBe(400);
    // original row unchanged, no phantom row under the new id
    expect((await store.listRuntimeTools()).map(r => r.id)).toEqual(['myapi__get_user']);
  });

  it('DELETE prunes an orphaned DB row not present in the registry', async () => {
    // Simulate a row that failed to reload (e.g. malformed on a prior boot):
    // it's in the store but never made it into the registry.
    await store.upsertRuntimeTool('orphan__tool', 'http', { ...httpBody, name: 'tool', namespace: 'orphan' } as never);
    expect(registry.getTool('orphan__tool')).toBeUndefined();
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/tools/orphan__tool' });
    expect(del.statusCode).toBe(204);
    expect(await store.listRuntimeTools()).toEqual([]);
  });

  it('records created_by as admin-ui', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/tools', payload: httpBody });
    expect((await store.listRuntimeTools())[0].created_by).toBe('admin-ui');
  });

  it('GET ?source=runtime returns only runtime tools, even behind many file tools', async () => {
    // A file tool sorts ahead of runtime tools and would dominate page 1.
    registry.addFileTool({
      id: 'sys__file_tool', driver: 'http', source: 'file',
      config: { ...httpBody, name: 'file_tool', namespace: 'sys' } as never,
      mcpDef: { name: 'sys__file_tool', inputSchema: { type: 'object' } },
    });
    await app.inject({ method: 'POST', url: '/api/v1/tools', payload: httpBody });

    const res = await app.inject({ method: 'GET', url: '/api/v1/tools?source=runtime' });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string; source: string }> }).data.map(t => t.id);
    expect(ids).toEqual(['myapi__get_user']);

    const bad = await app.inject({ method: 'GET', url: '/api/v1/tools?source=bogus' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('cli_whitelist gating on tool routes', () => {
  let app: FastifyInstance;
  let store: SplicedockStore;

  const cliBody = (command: string) => ({
    type: 'cli', name: command, namespace: 'fs', description: 'd',
    command, args: [], params: [], timeout_ms: 30000, env: [], auth: 'none',
  });

  beforeEach(async () => {
    const registry = new ToolRegistry();
    const service = new ToolService(registry);
    store = await SplicedockStore.open(':memory:');
    app = Fastify({ logger: false });
    registerToolRoutes(app, registry, service, store, ['ls']);
    await app.ready();
  });
  afterEach(async () => { await app.close(); await store.close(); });

  it('rejects a cli tool whose command is not whitelisted', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/tools', payload: cliBody('rm') });
    expect(res.statusCode).toBe(400);
    expect(await store.listRuntimeTools()).toEqual([]);
  });

  it('accepts a cli tool whose command is whitelisted', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/tools', payload: cliBody('ls') });
    expect(res.statusCode).toBe(201);
    expect((await store.listRuntimeTools()).map(r => r.id)).toEqual(['fs__ls']);
  });
});
