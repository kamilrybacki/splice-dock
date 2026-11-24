import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateProfileTokenAgent } from '../../../src/services/database/adapters/migrations/profiles/tokens/agent.js';
import { migrateProfileTokenLifecycle } from '../../../src/services/database/adapters/migrations/profiles/tokens/lifecycle.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { sqliteDb } from "../../helpers/sqlite.js";

it('migrates twice without changing legacy data and preserves lifecycle across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-migration-'));
  const file = join(dir, 'state.db');
  try {
    const db = new Database(file);
    db.exec("CREATE TABLE profile_tokens (id TEXT PRIMARY KEY, profile TEXT, token_hash TEXT UNIQUE, created_at INTEGER, last_used_at INTEGER); INSERT INTO profile_tokens VALUES ('legacy', 'ops', 'legacyhash', 1, NULL)");
    await migrateProfileTokenLifecycle(sqliteDb(db));
    const once = db.prepare('SELECT * FROM profile_tokens').all();
    await migrateProfileTokenLifecycle(sqliteDb(db));
    expect(db.prepare('SELECT * FROM profile_tokens').all()).toEqual(once);
    db.close();
    let store = await SplicedockStore.open(file);
    expect((await store.listProfileTokens())[0].expires_at).toBeNull();
    expect(await store.rotateProfileToken('legacy', 'successor', 'newhash', 60, 'operator')).toBe(true);
    await store.close();
    store = await SplicedockStore.open(file);
    expect(await store.findProfileByToken('legacyhash', Date.now())).toBeNull();
    expect((await store.findProfileByToken('newhash', Date.now()))?.id).toBe('successor');
    expect((await store.listProfileTokens()).find(t => t.id === 'legacy')?.revoked_by).toBe('operator');
    await store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('agent migration adds a nullable column, keeps legacy rows NULL, and is idempotent', async () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE profile_tokens (id TEXT PRIMARY KEY, profile TEXT, token_hash TEXT UNIQUE, created_at INTEGER, last_used_at INTEGER); INSERT INTO profile_tokens VALUES ('legacy', 'ops', 'h', 1, NULL)");
  await migrateProfileTokenAgent(sqliteDb(db));
  await migrateProfileTokenAgent(sqliteDb(db));
  expect(db.prepare('SELECT agent FROM profile_tokens').all()).toEqual([{ agent: null }]);
  db.close();
});
