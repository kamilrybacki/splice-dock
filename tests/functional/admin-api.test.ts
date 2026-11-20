import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHarness, type Harness } from './harness.js';

describe('Admin API integration', () => {
  let h: Harness;

  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => { await h.teardown(); });

  const authHeaders = () => ({
    'Authorization': `Bearer ${h.adminToken}`,
    'Content-Type': 'application/json',
  });

  it('GET /api/v1/health returns ok without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${h.adminPort}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string } };
    expect(body.data.status).toBe('ok');
  });

  it('GET /api/v1/tools returns 401 without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${h.adminPort}/api/v1/tools`);
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/tools registers a new HTTP tool', async () => {
    const toolBody = {
      type: 'http',
      name: 'get_user',
      namespace: 'myapi',
      description: 'Get a user',
      method: 'GET',
      url: 'https://api.example.com/users/{id}',
      params: [{ name: 'id', in: 'path', required: true }],
      auth: { type: 'none' },
    };

    const res = await fetch(`http://127.0.0.1:${h.adminPort}/api/v1/tools`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(toolBody),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toBe('/api/v1/tools/myapi__get_user');
    expect(h.toolRegistry.getTool('myapi__get_user')).toBeDefined();
  });

  it('DELETE /api/v1/tools/:id removes a runtime tool', async () => {
    h.toolRegistry.addRuntimeTool({
      id: 'test__tool',
      driver: 'http',
      source: 'runtime',
      config: { type: 'http', name: 'tool', namespace: 'test', description: 'd', method: 'GET', url: 'https://x.com', params: [], auth: { type: 'none' } },
      mcpDef: { name: 'test__tool', description: 'd', inputSchema: { type: 'object' } },
    });

    const res = await fetch(`http://127.0.0.1:${h.adminPort}/api/v1/tools/test__tool`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${h.adminToken}` },
    });

    expect(res.status).toBe(204);
    expect(h.toolRegistry.getTool('test__tool')).toBeUndefined();
  });

  it('GET /api/v1/manifest returns full YAML', async () => {
    const res = await fetch(`http://127.0.0.1:${h.adminPort}/api/v1/manifest`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('yaml');
    const body = await res.text();
    expect(body).toContain('server:');
  });
});
