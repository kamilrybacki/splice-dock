import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';

describe('SplicedockStore runtime_profiles', () => {
  let store: SplicedockStore;

  beforeEach(async () => { store = await SplicedockStore.open(':memory:'); });
  afterEach(async () => { await store.close(); });

  it('starts empty', async () => {
    expect(await store.listRuntimeProfiles()).toEqual([]);
  });

  it('upserts and reads back a runtime profile', async () => {
    await store.upsertRuntimeProfile('ops', ['grafana__*', 'argocd__get_*'], 'admin');
    const rows = await store.listRuntimeProfiles();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('ops');
    expect(rows[0].tools).toEqual(['grafana__*', 'argocd__get_*']);
    expect(rows[0].updated_by).toBe('admin');
    expect(rows[0].updated_at).toBeGreaterThan(0);
  });

  it('upsert on same name replaces the tool set (no duplicate row)', async () => {
    await store.upsertRuntimeProfile('ops', ['grafana__*'], 'admin');
    await store.upsertRuntimeProfile('ops', ['grafana__*', 'exa__*'], 'admin2');
    const rows = await store.listRuntimeProfiles();
    expect(rows).toHaveLength(1);
    expect(rows[0].tools).toEqual(['grafana__*', 'exa__*']);
    expect(rows[0].updated_by).toBe('admin2');
  });

  it('deletes a runtime profile and reports whether a row was removed', async () => {
    await store.upsertRuntimeProfile('ops', ['grafana__*']);
    expect(await store.deleteRuntimeProfile('ops')).toBe(true);
    expect(await store.listRuntimeProfiles()).toEqual([]);
    expect(await store.deleteRuntimeProfile('ops')).toBe(false);
  });

  it('skips malformed tools JSON instead of throwing', async () => {
    await store.upsertRuntimeProfile('good', ['grafana__*']);
    // Corrupt a row directly to simulate on-disk damage.
    // @ts-expect-error reach into private db for the test only
    await store['db'].prepare('UPDATE runtime_profiles SET tools_json = ? WHERE name = ?').run('{not json', 'good');
    expect(await store.listRuntimeProfiles()).toEqual([]);
  });
});
