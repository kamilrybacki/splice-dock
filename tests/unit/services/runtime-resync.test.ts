import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ToolRegistry } from '../../../src/services/tools/tool-registry.js';
import { ProfileRegistry } from '../../../src/services/profiles/profile-registry.js';
import { ToolService } from '../../../src/services/tools/base.js';
import { loadRuntimeTools, resyncRuntimeTools } from '../../../src/services/tools/runtime-tool-loader.js';
import { loadRuntimeProfiles, resyncRuntimeProfiles } from '../../../src/services/profiles/runtime-profile-loader.js';
import type { ToolConfig } from '../../../src/config/types.js';

const log = { info() {}, warn() {} };

const httpConfig: ToolConfig = {
  type: 'http', name: 'get_user', namespace: 'myapi', description: 'Get a user',
  method: 'GET', url: 'https://api.example.com/users/{id}',
  params: [{ name: 'id', in: 'path', required: true }], auth: { type: 'none' },
} as ToolConfig;

describe('resync loaders (cross-replica reload)', () => {
  let store: SplicedockStore;
  beforeEach(async () => { store = await SplicedockStore.open(':memory:'); });
  afterEach(async () => { await store.close(); });

  it('resyncRuntimeTools drops runtime tools deleted elsewhere and keeps file tools', async () => {
    const registry = new ToolRegistry();
    const toolService = new ToolService(registry);
    registry.addFileTool({
      id: 'file__tool', driver: 'http', source: 'file', config: httpConfig,
      mcpDef: { name: 'file__tool', inputSchema: { type: 'object' } },
    });
    await store.upsertRuntimeTool('myapi__get_user', 'http', httpConfig);
    await loadRuntimeTools(store, registry, toolService, log);
    expect(registry.getTool('myapi__get_user')).toBeDefined();

    // Another replica deletes the row; this replica still has it cached.
    await store.deleteRuntimeTool('myapi__get_user');
    await resyncRuntimeTools(store, registry, toolService, log);

    expect(registry.getTool('myapi__get_user')).toBeUndefined();
    expect(registry.getTool('file__tool')?.source).toBe('file');
  });

  it('resyncRuntimeTools picks up a tool created elsewhere', async () => {
    const registry = new ToolRegistry();
    const toolService = new ToolService(registry);
    await resyncRuntimeTools(store, registry, toolService, log);
    expect(registry.getTool('myapi__get_user')).toBeUndefined();

    await store.upsertRuntimeTool('myapi__get_user', 'http', httpConfig);
    await resyncRuntimeTools(store, registry, toolService, log);
    expect(registry.getTool('myapi__get_user')?.source).toBe('runtime');
  });

  it('resyncRuntimeProfiles applies updates and deletions made elsewhere, keeping file profiles', async () => {
    const registry = new ProfileRegistry();
    registry.addFileProfile('workspace', { tools: ['vault__*'] });
    await store.upsertRuntimeProfile('ops', ['grafana__*']);
    await store.upsertRuntimeProfile('dev', ['gh__*']);
    await loadRuntimeProfiles(store, registry, log);

    await store.upsertRuntimeProfile('ops', ['grafana__*', 'argocd__*']);
    await store.deleteRuntimeProfile('dev');
    await resyncRuntimeProfiles(store, registry, log);

    expect(registry.getProfile('ops')).toMatchObject({ tools: ['grafana__*', 'argocd__*'], source: 'runtime' });
    expect(registry.getProfile('dev')).toBeUndefined();
    expect(registry.getProfile('workspace')).toBeUndefined();
  });
});

describe('SplicedockStore invalidation support (SQLite)', () => {
  let store: SplicedockStore;
  beforeEach(async () => { store = await SplicedockStore.open(':memory:'); });
  afterEach(async () => { await store.close(); });

  it('reports it is not Postgres and notify is a no-op', async () => {
    expect(store.isPostgres).toBe(false);
    await expect(store.notify('splicedock_invalidate', '{}')).resolves.toBeUndefined();
  });

  it('runtimeFingerprint is stable when nothing changed and moves on write and delete', async () => {
    const a = await store.runtimeFingerprint();
    expect(await store.runtimeFingerprint()).toEqual(a);

    await store.upsertRuntimeTool('myapi__get_user', 'http', httpConfig);
    const b = await store.runtimeFingerprint();
    expect(b.tools).not.toBe(a.tools);
    expect(b.profiles).toBe(a.profiles);
    expect(b.policy).toBe(a.policy);

    await store.deleteRuntimeTool('myapi__get_user');
    expect((await store.runtimeFingerprint()).tools).toBe(a.tools);
  });

  it('resyncRuntimeProfiles keeps a local write that lands during the SELECT', async () => {
    const registry = new ProfileRegistry();
    const real = store.listRuntimeProfiles.bind(store);
    let first = true;
    store.listRuntimeProfiles = async () => {
      const rows = await real();
      if (first) { first = false; registry.addRuntimeProfile('fresh', { tools: ['gh__*'] }); }
      return rows;
    };
    await store.upsertRuntimeProfile('fresh', ['gh__*']);
    await resyncRuntimeProfiles(store, registry, log);
    expect(registry.getProfile('fresh')).toBeDefined();
  });

  it('resyncRuntimeTools keeps a local write that lands during the SELECT', async () => {
    const registry = new ToolRegistry();
    const toolService = new ToolService(registry);
    const real = store.listRuntimeTools.bind(store);
    let first = true;
    store.listRuntimeTools = async () => {
      const rows = await real();
      if (first) {
        first = false;
        // A real local write commits to the DB, then updates the registry.
        await store.upsertRuntimeTool('fresh', 'http', httpConfig);
        registry.addRuntimeTool({ id: 'fresh', driver: 'http', source: 'runtime', config: httpConfig, mcpDef: { name: 'fresh', inputSchema: { type: 'object' } } });
      }
      return rows;
    };
    await store.upsertRuntimeTool('myapi__get_user', 'http', httpConfig);
    await resyncRuntimeTools(store, registry, toolService, log);
    expect(registry.getTool('fresh')).toBeDefined();
    expect(registry.getTool('myapi__get_user')).toBeDefined();
  });
});
