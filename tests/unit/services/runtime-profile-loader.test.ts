import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ProfileRegistry } from '../../../src/services/profiles/registry.js';
import { loadRuntimeProfiles } from '../../../src/services/profiles/runtime/loader.js';

const log = { info: () => {}, warn: () => {} };

describe('loadRuntimeProfiles', () => {
  let store: SplicedockStore;

  beforeEach(async () => { store = await SplicedockStore.open(':memory:'); });
  afterEach(async () => { await store.close(); });

  it('re-registers a persisted runtime profile into a fresh registry', async () => {
    await store.upsertRuntimeProfile('ops', ['grafana__*', 'argocd__get_*']);
    const registry = new ProfileRegistry();
    const summary = await loadRuntimeProfiles(store, registry, log);
    expect(summary.loaded).toBe(1);
    expect(registry.getProfile('ops')).toMatchObject({ tools: ['grafana__*', 'argocd__get_*'], source: 'runtime' });
  });

  it('skips a persisted row that uses a reserved name', async () => {
    await store.upsertRuntimeProfile('__no_tools__', ['grafana__*']);
    const registry = new ProfileRegistry();
    const summary = await loadRuntimeProfiles(store, registry, log);
    expect(summary.loaded).toBe(0);
    expect(summary.skipped_reserved).toBe(1);
    expect(registry.getProfile('__no_tools__')).toBeUndefined();
  });

  it('loads the database catalog over a stale file entry', async () => {
    await store.upsertRuntimeProfile('workspace', ['grafana__*']);
    const registry = new ProfileRegistry();
    registry.addFileProfile('workspace', { tools: ['vault__*'] });
    expect((await loadRuntimeProfiles(store, registry, log)).loaded).toBe(1);
    expect(registry.getProfile('workspace')).toMatchObject({ tools: ['grafana__*'], source: 'runtime' });
  });

  it('skips a row whose tool set fails re-validation instead of crashing', async () => {
    await store.upsertRuntimeProfile('empty', []); // profileSchema requires >= 1 tool
    const registry = new ProfileRegistry();
    const summary = await loadRuntimeProfiles(store, registry, log);
    expect(summary.loaded).toBe(0);
    expect(summary.skipped_invalid).toBe(1);
    expect(registry.getProfile('empty')).toBeUndefined();
  });
});
