import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ToolRegistry } from '../../../src/services/tools/registry.js';
import { ToolService } from '../../../src/services/tools/base.js';
import { loadRuntimeTools } from '../../../src/services/tools/runtime/loader.js';
import type { ToolConfig } from '../../../src/config/types.js';

const noopLog = { info() {}, warn() {} };

const httpConfig: ToolConfig = {
  type: 'http', name: 'get_user', namespace: 'myapi', description: 'Get a user',
  method: 'GET', url: 'https://api.example.com/users/{id}',
  params: [{ name: 'id', in: 'path', required: true }], auth: { type: 'none' },
} as ToolConfig;

const cliConfig: ToolConfig = {
  type: 'cli', name: 'ls', namespace: 'fs', description: 'List',
  command: 'ls', args: [], params: [], timeout_ms: 30000, env: [], auth: 'none',
} as ToolConfig;

describe('loadRuntimeTools', () => {
  let store: SplicedockStore;
  let registry: ToolRegistry;
  let toolService: ToolService;

  beforeEach(async () => {
    store = await SplicedockStore.open(':memory:');
    registry = new ToolRegistry();
    toolService = new ToolService(registry);
  });
  afterEach(async () => await store.close());

  it('re-registers persisted http and cli tools into the registry', async () => {
    await store.upsertRuntimeTool('myapi__get_user', 'http', httpConfig);
    await store.upsertRuntimeTool('fs__ls', 'cli', cliConfig);

    const summary = await loadRuntimeTools(store, registry, toolService, noopLog);

    expect(summary.loaded).toBe(2);
    const a = registry.getTool('myapi__get_user');
    const b = registry.getTool('fs__ls');
    expect(a?.source).toBe('runtime');
    expect(a?.driver).toBe('http');
    expect(b?.driver).toBe('cli');
    expect(a?.mcpDef.name).toBe('myapi__get_user');
  });

  it('skips a runtime tool that collides with a file-defined id', async () => {
    registry.addFileTool({
      id: 'myapi__get_user', driver: 'http', source: 'file', config: httpConfig,
      mcpDef: { name: 'myapi__get_user', inputSchema: { type: 'object' } },
    });
    await store.upsertRuntimeTool('myapi__get_user', 'http', httpConfig);

    const summary = await loadRuntimeTools(store, registry, toolService, noopLog);

    expect(summary.loaded).toBe(0);
    expect(summary.skipped_file_collision).toBe(1);
    expect(registry.getTool('myapi__get_user')?.source).toBe('file');
  });

  it('skips a shape-invalid persisted row without throwing (no startup crash)', async () => {
    // A JSON-valid but schema-invalid config (e.g. config drift / manual edit).
    await store.upsertRuntimeTool('bad__tool', 'http', { type: 'http', name: 'bad' } as never);
    await store.upsertRuntimeTool('myapi__get_user', 'http', httpConfig);

    const summary = await loadRuntimeTools(store, registry, toolService, noopLog);

    expect(summary.skipped_invalid).toBe(1);
    expect(summary.loaded).toBe(1);
    expect(registry.getTool('bad__tool')).toBeUndefined();
    expect(registry.getTool('myapi__get_user')).toBeDefined();
  });

  it('skips a cli row whose command is no longer whitelisted', async () => {
    await store.upsertRuntimeTool('fs__ls', 'cli', cliConfig);
    const summary = await loadRuntimeTools(store, registry, toolService, noopLog, ['echo']); // 'ls' not allowed
    expect(summary.skipped_invalid).toBe(1);
    expect(registry.getTool('fs__ls')).toBeUndefined();
  });
});
