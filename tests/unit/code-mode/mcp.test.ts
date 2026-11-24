import { it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../../../src/services/mcp/adapters/express/server.js';
import { ToolRegistry } from '../../../src/services/tools/tool-registry.js';
import { ProfileRegistry } from '../../../src/services/profiles/profile-registry.js';
import { createServer } from 'node:http';
import { runWithCaller } from '../../../src/common/request-context.js';
import { ProfileService } from '../../../src/services/profiles/base.js';

it('gates the builtin independently of tool patterns and checks each nested call', async () => {
  const profiles = new ProfileRegistry();
  profiles.addRuntimeProfile('ops', { tools: ['*'], enable_code_mode: false });
  const tools = new ToolRegistry();
  const server = buildMcpServer('ops', new ProfileService(profiles, tools), new Map(), tools);
  const client = new Client({ name: 'test', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    expect((await client.listTools()).tools.some(t => t.name === 'code_mode__execute')).toBe(false);
    expect((await client.callTool({name:'code_mode__execute', arguments:{code:'return 1;'}})).isError).toBe(true);
    profiles.addRuntimeProfile('ops', {tools:['allowed__*'], enable_code_mode:true});
    expect((await client.listTools()).tools.some(t => t.name === 'code_mode__execute')).toBe(true);
    const result = await client.callTool({name:'code_mode__execute', arguments:{code:'return await tools.call("forbidden__read", {});'}});
    expect(result.structuredContent).toMatchObject({result:{isError:true}});
    expect(JSON.stringify(result)).toContain('not found for profile');
  } finally { await client.close(); await server.close(); }
});

it('uses the materialized HTTP request at the real MCP entry point and refuses unreviewed egress', async () => {
  const seen: { path: string; payload: unknown }[] = [];
  const fake = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    seen.push({ path: req.url ?? '', payload });
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/mock' ? '{"status":200,"body":"preview"}'
      : req.url === '/review' ? '{"decision":"allow"}' : '{}');
  });
  await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve));
  const address = fake.address();
  if (!address || typeof address === 'string') throw Error('Missing fixture address');
  const base = `http://127.0.0.1:${address.port}`;
  const profiles = new ProfileRegistry();
  profiles.addRuntimeProfile('ops', { tools: ['demo__*'], enable_code_mode: true });
  const tools = new ToolRegistry();
  tools.addFileTool({
    id: 'demo__write', driver: 'http', source: 'file',
    config: { type: 'http', name: 'write', namespace: 'demo', description: 'Fictional write',
      method: 'POST', url: base + '/live', params: [{ name: 'title', in: 'body', required: true }],
      auth: { type: 'none' } },
    mcpDef: { name: 'demo__write', inputSchema: { type: 'object' } },
  });
  const server = buildMcpServer('ops', new ProfileService(profiles, tools), new Map(), tools);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    vi.stubEnv('SPLICEDOCK_CODE_MODE_PREFLIGHT', 'enforce');
    vi.stubEnv('SPLICEDOCK_CODE_MODE_PREFLIGHT_PROFILES', 'ops');
    vi.stubEnv('SPLICEDOCK_CODE_MODE_MOCK_URL', base + '/mock');
    vi.stubEnv('SPLICEDOCK_CODE_MODE_REVIEW_URL', base + '/review');
    const request = {
      name: 'code_mode__execute',
      arguments: { code: 'return await tools.call("demo__write", {title: "Fictional"});' },
    };
    expect((await client.callTool(request)).isError).toBe(true);
    expect(seen).toEqual([]);
    const result = await runWithCaller({ profile: 'ops', tokenId: 'test', authenticated: true }, () =>
      client.callTool(request));
    expect(result.isError).not.toBe(true);
    expect(seen.map(x => x.path)).toEqual(['/mock', '/review', '/live']);
    expect(seen[1].payload).toMatchObject({ requests: [{ method: 'POST', url: base + '/live', body: '{"title":"Fictional"}' }] });
    expect(seen[2].payload).toEqual({ title: 'Fictional' });
  } finally {
    vi.unstubAllEnvs();
    await Promise.all([client.close(), server.close()]);
    await new Promise<void>((resolve, reject) => fake.close(error => error ? reject(error) : resolve()));
  }
});
