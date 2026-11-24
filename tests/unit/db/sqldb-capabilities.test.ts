import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteDb } from '../../../src/services/database/adapters/sqlite/db.js';

const tables = (raw: Database.Database): string[] =>
  (raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);

describe('SqliteDb capabilities', () => {
  it('rowLock is empty because BEGIN IMMEDIATE serialises writers', () => {
    const db = new SqliteDb(new Database(':memory:'));
    expect(db.rowLock('update')).toBe('');
    expect(db.rowLock('skip_locked')).toBe('');
  });

  it('lockInTransaction resolves inside a transaction', async () => {
    const db = new SqliteDb(new Database(':memory:'));
    await expect(db.transaction(async () => { await db.lockInTransaction('k'); return 1; }).immediate()).resolves.toBe(1);
  });

  it('ensureSchema creates every service table, is idempotent and shares concurrent runs', async () => {
    const raw = new Database(':memory:');
    const db = new SqliteDb(raw);
    const first = db.ensureSchema();
    const second = db.ensureSchema();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await db.ensureSchema();
    expect(tables(raw)).toEqual(expect.arrayContaining([
      'breaker_state', 'breaker_buckets', 'breaker_audit', 'breaker_probe_ids', 'breaker_migrations',
      's1_shadow_log', 'webauthn_credentials', 'consent_challenges', 'consent_credentials',
      'pending_approvals', 'policy_overrides', 'profile_tokens', 'standing_grants',
    ]));
    const cols = (raw.prepare('PRAGMA table_info(pending_approvals)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['kind', 'level', 'profile', 'shape_key']));
  });

  it('a fresh instance on the same file also migrates cleanly (no memo shared)', async () => {
    const raw = new Database(':memory:');
    await new SqliteDb(raw).ensureSchema();
    await expect(new SqliteDb(raw).ensureSchema()).resolves.toBeUndefined();
  });

  it('clears the memo when ensureSchema rejects so a retry can succeed', async () => {
    const raw = new Database(':memory:');
    const db = new SqliteDb(raw);
    raw.exec('CREATE TABLE policy_overrides (x INTEGER)'); // conflicting legacy shape: index/columns fail later
    raw.exec('CREATE VIEW breaker_state AS SELECT 1 AS scope'); // makes CREATE TABLE ... breaker_state conflict
    await expect(db.ensureSchema()).rejects.toThrow();
    raw.exec('DROP VIEW breaker_state');
    raw.exec('DROP TABLE policy_overrides');
    await expect(db.ensureSchema()).resolves.toBeUndefined();
  });
});
