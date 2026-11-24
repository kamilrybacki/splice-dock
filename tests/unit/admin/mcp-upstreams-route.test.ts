import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerMcpUpstreamRoutes } from '../../../src/services/admin/adapters/fastify/routes/mcp-upstreams.js';
import { McpUpstreamManager } from '../../../src/services/upstreams/base.js';
import type { McpProxyToolConfig } from '../../../src/config/types.js';

const fileCfg = { type: 'mcp_proxy', name: 'filed', service_dns: 'f.svc', port: 1 } as unknown as McpProxyToolConfig;
const body = { name: 'my-up', service_dns: 'a.tools.svc', port: 8000 };

describe('mcp-upstreams routes', () => {
  let app: FastifyInstance;
  let configs: McpProxyToolConfig[];
  let refreshOne: ReturnType<typeof vi.fn>;
  let removeUpstreamTools: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    configs = [fileCfg];
    refreshOne = vi.fn(async () => undefined);
    removeUpstreamTools = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn() };
    const mgr = new McpUpstreamManager(configs, { removeUpstreamTools } as never, { refreshOne }, undefined, log);
    app = Fastify({ logger: false });
    registerMcpUpstreamRoutes(app, mgr, ['*.tools.svc']);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  it('creates, lists and deletes a runtime upstream', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp-upstreams', payload: body });
    expect(res.statusCode).toBe(201);
    expect(refreshOne).toHaveBeenCalledTimes(1);
    expect(configs.map((c) => c.name)).toEqual(['filed', 'my-up']);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/mcp-upstreams' })).json().data;
    expect(list.map((u: { source: string }) => u.source)).toEqual(['file', 'runtime']);
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/mcp-upstreams/my-up' });
    expect(del.statusCode).toBe(204);
    expect(removeUpstreamTools).toHaveBeenCalledWith('my-up');
    expect(configs.map((c) => c.name)).toEqual(['filed']);
  });

  it('rejects hosts outside the allowlist with 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp-upstreams', payload: { ...body, service_dns: 'evil.com' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('host_not_allowed');
  });

  it('409 on duplicate and on file-defined; 404 on unknown', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/mcp-upstreams', payload: body });
    expect((await app.inject({ method: 'POST', url: '/api/v1/mcp-upstreams', payload: body })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/mcp-upstreams/filed' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/mcp-upstreams/nope' })).statusCode).toBe(404);
  });

  it('422 on invalid name; 400 on rename via PUT', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/mcp-upstreams', payload: { ...body, name: 'Bad Name' } })).statusCode).toBe(422);
    await app.inject({ method: 'POST', url: '/api/v1/mcp-upstreams', payload: body });
    expect((await app.inject({ method: 'PUT', url: '/api/v1/mcp-upstreams/my-up', payload: { ...body, name: 'other' } })).statusCode).toBe(400);
  });
});
