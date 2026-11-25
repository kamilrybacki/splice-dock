import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';

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

describe('SplicedockStore runtime_profiles created_at (profile identity)', () => {
  let store: SplicedockStore;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    store = await SplicedockStore.open(':memory:');
  });
  afterEach(async () => {
    await store.close();
    vi.useRealTimers();
  });

  it('stamps created_at when a profile is first saved', async () => {
    await store.upsertRuntimeProfile('ops', ['a__*']);
    expect((await store.getRuntimeProfile('ops'))?.created_at).toBe(1_800_000_000_000);
  });

  it('keeps created_at across updates while updated_at moves on', async () => {
    await store.upsertRuntimeProfile('ops', ['a__*']);
    vi.setSystemTime(1_800_000_005_000);
    await store.upsertRuntimeProfile('ops', ['a__*', 'b__*']);
    const row = await store.getRuntimeProfile('ops');
    expect(row?.created_at).toBe(1_800_000_000_000);
    expect(row?.updated_at).toBe(1_800_000_005_000);
    expect(row?.revision).toBe(2);
  });

  it('gives a delete-and-recreate a new created_at even though its revision resets', async () => {
    await store.upsertRuntimeProfile('ops', ['a__*']);
    const first = await store.getRuntimeProfile('ops');
    await store.deleteRuntimeProfile('ops');
    vi.setSystemTime(1_800_000_007_000);
    await store.upsertRuntimeProfile('ops', ['a__*']);
    const second = await store.getRuntimeProfile('ops');
    expect(second?.revision).toBe(first?.revision);
    expect(second?.created_at).toBe(1_800_000_007_000);
    expect(second?.created_at).not.toBe(first?.created_at);
  });

  it('lists created_at with every row', async () => {
    await store.upsertRuntimeProfile('ops', ['a__*']);
    expect((await store.listRuntimeProfiles())[0]?.created_at).toBe(1_800_000_000_000);
  });

  it('changes the runtime fingerprint when a profile is recreated with identical content', async () => {
    await store.upsertRuntimeProfile('ops', ['a__*']);
    const before = (await store.runtimeFingerprint()).profiles;
    await store.deleteRuntimeProfile('ops');
    vi.setSystemTime(1_800_000_001_000);
    await store.upsertRuntimeProfile('ops', ['a__*']);
    expect((await store.runtimeFingerprint()).profiles).not.toBe(before);
  });
});

describe('runtime_profiles created_at migration', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'splicedock-created-at-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('adds created_at to a legacy table and backfills it from updated_at', async () => {
    const file = join(dir, 'legacy.db');
    const seed = await SplicedockStore.open(file);
    // @ts-expect-error reach into private db for the test only
    const db = seed['db'];
    await db.exec('DROP TABLE runtime_profiles');
    await db.exec(`CREATE TABLE runtime_profiles (name TEXT PRIMARY KEY, tools_json TEXT NOT NULL, manifest_yaml TEXT,
      revision INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'runtime', updated_at INTEGER NOT NULL, updated_by TEXT)`);
    await db.prepare('INSERT INTO runtime_profiles (name, tools_json, updated_at) VALUES (?, ?, ?)').run('old', '["a__*"]', 1_700_000_000_000);
    await seed.close();

    const reopened = await SplicedockStore.open(file);
    try {
      const row = await reopened.getRuntimeProfile('old');
      expect(row?.created_at).toBe(1_700_000_000_000);
      await reopened.upsertRuntimeProfile('old', ['a__*', 'b__*']);
      expect((await reopened.getRuntimeProfile('old'))?.created_at).toBe(1_700_000_000_000);
    } finally {
      await reopened.close();
    }
  });
});
