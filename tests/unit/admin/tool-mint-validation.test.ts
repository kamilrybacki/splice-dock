import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerToolRoutes } from '../../../src/services/admin/adapters/fastify/routes/tools.js';
import { registerMcpUpstreamRoutes } from '../../../src/services/admin/adapters/fastify/routes/mcp/upstreams.js';
import { ToolRegistry } from '../../../src/services/tools/registry.js';
import { ToolService } from '../../../src/services/tools/base.js';
import { McpUpstreamManager } from '../../../src/services/upstreams/base.js';
import { loadRuntimeTools } from '../../../src/services/tools/runtime/loader.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { runtimeToolSchema } from '../../../src/config/tool-credentials.js';
import { parseConfig } from '../../../src/config-file.js';
import type { McpProxyToolConfig } from '../../../src/config/types.js';

// Tool-level `mint:` has no profile identity to mint for, so the config loader
// refuses it. Every runtime path that parses a tool definition must refuse it
// with the same message.

const httpBase = {
  type: 'http', name: 'get_user', namespace: 'myapi', description: 'Get a user',
  method: 'GET', url: 'https://api.example.com/users/{id}',
  params: [{ name: 'id', in: 'path', required: true }],
};
const bearerMint = { ...httpBase, auth: { type: 'bearer', token: { mint: 'gh' } } };
const headerMint = { ...httpBase, auth: { type: 'header', name: 'X-Key', value: { mint: 'gh' } } };
const upstreamMint = {
  name: 'my-up', service_dns: 'a.tools.svc', port: 8000,
  auth: { type: 'bearer', token: { mint: 'gh' } },
};

const BEARER_MESSAGE =
  "tools.get_user.auth.token: mint 'gh' is only valid in profiles.<name>.credentials (tool-level auth is resolved without a profile identity)";
const HEADER_MESSAGE =
  "tools.get_user.auth.value: mint 'gh' is only valid in profiles.<name>.credentials (tool-level auth is resolved without a profile identity)";

const issueMessages = (res: { json(): { error: { details: Array<{ message: string }> } } }): string[] =>
  res.json().error.details.map(d => d.message);

describe('admin tool routes reject tool-level mint', () => {
  let app: FastifyInstance;
  let store: SplicedockStore;

  beforeEach(async () => {
    const registry = new ToolRegistry();
    store = await SplicedockStore.open(':memory:');
    app = Fastify({ logger: false });
    registerToolRoutes(app, registry, new ToolService(registry), store);
    await app.ready();
  });
  afterEach(async () => { await app.close(); await store.close(); });

  it.each([
    ['bearer token', bearerMint, BEARER_MESSAGE],
    ['header value', headerMint, HEADER_MESSAGE],
  ])('POST refuses mint in an http %s and persists nothing', async (_label, payload, message) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/tools', payload });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    expect(issueMessages(res)).toEqual([message]);
    expect(await store.listRuntimeTools()).toEqual([]);
  });

  it('PUT refuses mint and leaves the stored tool untouched', async () => {
    const valid = { ...httpBase, auth: { type: 'none' } };
    expect((await app.inject({ method: 'POST', url: '/api/v1/tools', payload: valid })).statusCode).toBe(201);

    const res = await app.inject({ method: 'PUT', url: '/api/v1/tools/myapi__get_user', payload: bearerMint });
    expect(res.statusCode).toBe(422);
    expect(issueMessages(res)).toEqual([BEARER_MESSAGE]);
    const rows = await store.listRuntimeTools();
    expect((rows[0]!.config as { auth: unknown }).auth).toEqual({ type: 'none' });
  });

  it('POST refuses mint on an mcp_proxy body with the same validation error', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/tools',
      payload: { type: 'mcp_proxy', name: 'my-up', service_dns: 'a.tools.svc', port: 8000, auth: upstreamMint.auth },
    });
    expect(res.statusCode).toBe(422);
    expect(issueMessages(res)[0]).toMatch(/is only valid in profiles\.<name>\.credentials/);
  });

  it('still accepts static from: credentials and no auth', async () => {
    const withFrom = { ...httpBase, auth: { type: 'bearer', token: { from: 'env:API_TOKEN' } } };
    const res = await app.inject({ method: 'POST', url: '/api/v1/tools', payload: withFrom });
    expect(res.statusCode).toBe(201);
    const none = await app.inject({
      method: 'POST', url: '/api/v1/tools', payload: { ...httpBase, name: 'other', auth: { type: 'none' } },
    });
    expect(none.statusCode).toBe(201);
    expect((await store.listRuntimeTools()).map(r => r.id).sort()).toEqual(['myapi__get_user', 'myapi__other']);
  });
});

describe('admin mcp-upstream routes reject tool-level mint', () => {
  let app: FastifyInstance;
  let configs: McpProxyToolConfig[];
  let refreshOne: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    configs = [];
    refreshOne = vi.fn(async () => undefined);
    const log = { info: vi.fn(), warn: vi.fn() };
    const mgr = new McpUpstreamManager(configs, { removeUpstreamTools: vi.fn() } as never, { refreshOne }, undefined, log);
    app = Fastify({ logger: false });
    registerMcpUpstreamRoutes(app, mgr, ['*.tools.svc']);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  it('POST refuses mint auth and registers nothing', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp-upstreams', payload: upstreamMint });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    expect(issueMessages(res)).toEqual([
      "tools.my-up.auth.token: mint 'gh' is only valid in profiles.<name>.credentials (tool-level auth is resolved without a profile identity)",
    ]);
    expect(configs).toEqual([]);
    expect(refreshOne).not.toHaveBeenCalled();
  });

  it('POST still accepts a static from: bearer', async () => {
    const payload = { ...upstreamMint, auth: { type: 'bearer', token: { from: 'env:UP_TOKEN' } } };
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp-upstreams', payload });
    expect(res.statusCode).toBe(201);
    expect(configs.map(c => c.name)).toEqual(['my-up']);
  });
});

describe('stored rows with tool-level mint are skipped on reload', () => {
  const noopLog = { info() {}, warn() {} };
  let store: SplicedockStore;

  beforeEach(async () => { store = await SplicedockStore.open(':memory:'); });
  afterEach(async () => { await store.close(); });

  it('loadRuntimeTools skips the mint row and loads the valid one', async () => {
    const registry = new ToolRegistry();
    await store.upsertRuntimeTool('myapi__get_user', 'http', bearerMint as never);
    await store.upsertRuntimeTool('myapi__ok', 'http', { ...httpBase, name: 'ok', auth: { type: 'none' } } as never);

    const summary = await loadRuntimeTools(store, registry, new ToolService(registry), noopLog);

    expect(summary.loaded).toBe(1);
    expect(summary.skipped_invalid).toBe(1);
    expect(registry.getTool('myapi__get_user')).toBeUndefined();
    expect(registry.getTool('myapi__ok')).toBeDefined();
  });

  it('McpUpstreamManager.syncFromStore skips the mint row', async () => {
    await store.upsertRuntimeTool('bad-up', 'mcp_proxy', { type: 'mcp_proxy', ...upstreamMint, name: 'bad-up' } as never);
    await store.upsertRuntimeTool('good-up', 'mcp_proxy', {
      type: 'mcp_proxy', name: 'good-up', service_dns: 'a.tools.svc', port: 8000,
    } as never);
    const configs: McpProxyToolConfig[] = [];
    const warn = vi.fn();
    const mgr = new McpUpstreamManager(
      configs, { removeUpstreamTools: vi.fn() } as never, { refreshOne: vi.fn(async () => undefined) },
      store, { info: vi.fn(), warn },
    );

    await mgr.syncFromStore();

    expect(configs.map(c => c.name)).toEqual(['good-up']);
    expect(warn).toHaveBeenCalledWith('runtime mcp upstream skipped', { id: 'bad-up' });
  });
});

describe('runtime and loader report the same error', () => {
  const YAML_HEAD = `
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
  cli_whitelist: [gh]
credential_providers:
  gh:
    type: command
    command: /usr/local/bin/mint-gh
    ttl_seconds: 3000
`;

  it('matches the loader for tool-level auth', () => {
    const issue = runtimeToolSchema.safeParse({
      type: 'mcp_proxy', name: 'vault', service_dns: 'vault.svc', port: 8000,
      auth: { type: 'bearer', token: { mint: 'gh' } },
    });
    expect(issue.success).toBe(false);
    const message = issue.success ? '' : issue.error.issues[0]!.message;
    expect(() => parseConfig(`${YAML_HEAD}tools:
  - type: mcp_proxy
    name: vault
    service_dns: vault.svc
    port: 8000
    auth:
      type: bearer
      token: { mint: gh }
`)).toThrow(message);
  });

  it('matches the loader for tool-level cli env', () => {
    const issue = runtimeToolSchema.safeParse({
      type: 'cli_passthrough', name: 'gh', description: 'GitHub CLI', command: 'gh',
      env: [{ name: 'GH_TOKEN', mint: 'gh' }],
    });
    expect(issue.success).toBe(false);
    const message = issue.success ? '' : issue.error.issues[0]!.message;
    expect(() => parseConfig(`${YAML_HEAD}tools:
  - type: cli_passthrough
    name: gh
    description: GitHub CLI
    command: gh
    env:
      - name: GH_TOKEN
        mint: gh
`)).toThrow(message);
  });

  it('accepts definitions without a tool-level mint', () => {
    expect(runtimeToolSchema.safeParse({ ...httpBase, auth: { type: 'none' } }).success).toBe(true);
    expect(runtimeToolSchema.safeParse({
      type: 'cli_passthrough', name: 'gh', description: 'GitHub CLI', command: 'gh',
      env: [{ name: 'GH_TOKEN', from: 'env:GH_TOKEN' }],
    }).success).toBe(true);
  });
});
