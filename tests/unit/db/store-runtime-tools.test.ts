import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import type { ToolConfig } from '../../../src/config/types.js';

const httpConfig: ToolConfig = {
  type: 'http',
  name: 'get_user',
  namespace: 'myapi',
  description: 'Get a user',
  method: 'GET',
  url: 'https://api.example.com/users/{id}',
  params: [{ name: 'id', in: 'path', required: true }],
  auth: { type: 'none' },
} as ToolConfig;

describe('SplicedockStore runtime_tools', () => {
  let store: SplicedockStore;

  beforeEach(async () => { store = await SplicedockStore.open(':memory:'); });
  afterEach(async () => { await store.close(); });

  it('starts empty', async () => {
    expect(await store.listRuntimeTools()).toEqual([]);
  });

  it('upserts and reads back a runtime tool', async () => {
    await store.upsertRuntimeTool('myapi__get_user', 'http', httpConfig, 'admin');
    const rows = await store.listRuntimeTools();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('myapi__get_user');
    expect(rows[0].driver).toBe('http');
    expect(rows[0].created_by).toBe('admin');
    expect(rows[0].config).toEqual(httpConfig);
    expect(rows[0].created_at).toBeGreaterThan(0);
  });

  it('upsert on same id replaces config (no duplicate row)', async () => {
    await store.upsertRuntimeTool('myapi__get_user', 'http', httpConfig, 'admin');
    const updated = { ...httpConfig, description: 'Updated desc' } as ToolConfig;
    await store.upsertRuntimeTool('myapi__get_user', 'http', updated, 'admin2');
    const rows = await store.listRuntimeTools();
    expect(rows).toHaveLength(1);
    expect((rows[0].config as { description: string }).description).toBe('Updated desc');
    expect(rows[0].created_by).toBe('admin2');
  });

  it('deletes a runtime tool and reports whether a row was removed', async () => {
    await store.upsertRuntimeTool('myapi__get_user', 'http', httpConfig);
    expect(await store.deleteRuntimeTool('myapi__get_user')).toBe(true);
    expect(await store.listRuntimeTools()).toEqual([]);
    expect(await store.deleteRuntimeTool('myapi__get_user')).toBe(false);
  });

  it('skips malformed config rows instead of throwing', async () => {
    await store.upsertRuntimeTool('good__one', 'http', httpConfig);
    // Corrupt a row directly to simulate on-disk damage.
    // @ts-expect-error reach into private db for the test only
    await store['db'].prepare('UPDATE runtime_tools SET config_json = ? WHERE id = ?').run('{not json', 'good__one');
    expect(await store.listRuntimeTools()).toEqual([]);
  });
});
