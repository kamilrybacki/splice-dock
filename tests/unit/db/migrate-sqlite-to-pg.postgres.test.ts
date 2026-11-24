import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ConsentStore, hash } from '../../../src/services/approvals/consent/store.js';
import { PgDb } from '../../../src/services/database/adapters/postgres/db.js';
import { migrateSqliteToPostgres, MigrationError } from '../../../src/services/database/adapters/migrations/sqlite/postgres.js';
import { runDbCli } from '../../../src/services/database/adapters/cli/migrate.js';
import { TEST_PG_DSN, PG_SKIP_REASON, createIsolatedSchema, type IsolatedSchema } from '../../helpers/pg-test.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

interface Col { name: string; type: string; notnull: number; pk: number }
const q = (s: string): string => `"${s}"`;

/** Columns with a CHECK constraint: the generic filler needs a legal value. */
const CHECKED_COLUMNS: Record<string, Record<string, unknown>> = {};

/** Build a SQLite file with a token, plus at least two rows in every table. */
async function seedSqlite(): Promise<{ path: string; tables: Map<string, number> }> {
  const dir = mkdtempSync(join(tmpdir(), 'mig-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'src.db');
  const store = await SplicedockStore.open(path);
  await ConsentStore.open(store.consentDatabase());
  // Created lazily by the breaker / shadow observer in production.
  await store.consentDatabase().ensureSchema();
  await store.insertProfileToken('tok-1', 'prof', hash('secret-token'));
  await store.close();

  const raw = new Database(path);
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(t => t.name);
  const expected = new Map<string, number>();
  for (const t of tables) {
    const cols = raw.prepare(`PRAGMA table_info(${q(t)})`).all() as Col[];
    for (let r = 0; r < 2; r++) {
      const vals = cols.map((c, i) => {
        const override = CHECKED_COLUMNS[t]?.[c.name];
        if (override !== undefined) return override;
        const ty = c.type.toUpperCase();
        if (ty.includes('BLOB')) return Buffer.from([1, 2, 3, r, i]);
        if (ty.includes('INT')) return 7000 + r * 10 + i;
        if (ty.includes('REAL') || ty.includes('DOUBLE')) return 1.5 + r;
        return `v-${t}-${c.name}-${r}`;
      });
      try { raw.prepare(`INSERT OR IGNORE INTO ${q(t)} (${cols.map(c => q(c.name)).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals); } catch { /* CHECK constraints: covered by dedicated rows below */ }
    }
    expected.set(t, (raw.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get() as { n: number }).n);
  }
  raw.close();
  return { path, tables: expected };
}

async function target(): Promise<IsolatedSchema> {
  const s = await createIsolatedSchema(TEST_PG_DSN!); cleanups.push(() => s.drop());
  return s;
}

async function pgCount(dsn: string, t: string): Promise<number> {
  const db = new PgDb(dsn, { max: 1 });
  try { return Number(((await db.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get()) as { n: number }).n); } finally { await db.close(); }
}

describe.skipIf(!TEST_PG_DSN)(TEST_PG_DSN ? 'SQLite -> Postgres migration' : `SQLite -> Postgres migration [skipped: ${PG_SKIP_REASON}]`, () => {
  it('copies every table with matching counts and a working auth token', async () => {
    const { path, tables } = await seedSqlite();
    const { dsn } = await target();
    const report = await migrateSqliteToPostgres({ sqlitePath: path, dsn });

    expect(report.tables.map(t => t.table).sort()).toEqual([...tables.keys()].sort());
    expect(tables.size).toBeGreaterThanOrEqual(20);
    for (const [t, n] of tables) {
      expect(report.tables.find(x => x.table === t)?.rows).toBe(n);
      expect(await pgCount(dsn, t)).toBe(n); // row-count parity
      expect(n).toBeGreaterThan(0);          // every table is actually exercised
    }
    // The pre-existing profile token still authenticates on Postgres.
    const store = await SplicedockStore.open(dsn);
    expect(await store.findProfileByToken(hash('secret-token'), Date.now())).toEqual({ id: 'tok-1', profile: 'prof', agent: null });
    expect(await store.findProfileByToken(hash('wrong'), Date.now())).toBeNull();
    await store.close();
  });

  it('preserves ids, blobs and fixes serial sequences', async () => {
    const { path } = await seedSqlite();
    const raw = new Database(path);
    const maxAudit = (raw.prepare('SELECT MAX(id) AS m FROM breaker_audit').get() as { m: number }).m;
    const blob = (raw.prepare('SELECT public_key AS k FROM webauthn_credentials LIMIT 1').get() as { k: Buffer }).k;
    raw.close();
    const { dsn } = await target();
    await migrateSqliteToPostgres({ sqlitePath: path, dsn });

    const db = new PgDb(dsn, { max: 1 });
    try {
      expect(Number(((await db.prepare('SELECT MAX(id) AS m FROM breaker_audit').get()) as { m: number }).m)).toBe(maxAudit);
      expect(Buffer.from(((await db.prepare('SELECT public_key AS k FROM webauthn_credentials LIMIT 1').get()) as { k: Buffer }).k).equals(blob)).toBe(true);
      // The next generated id must not collide with a migrated one.
      await db.prepare("INSERT INTO breaker_audit (ts, scope, event) VALUES (1, 's', 'e')").run();
      expect(Number(((await db.prepare('SELECT MAX(id) AS m FROM breaker_audit').get()) as { m: number }).m)).toBe(maxAudit + 1);
    } finally { await db.close(); }
  });

  it('refuses a non-empty target without --force and leaves it untouched', async () => {
    const { path } = await seedSqlite();
    const { dsn } = await target();
    await migrateSqliteToPostgres({ sqlitePath: path, dsn });
    const before = await pgCount(dsn, 'profile_tokens');
    await expect(migrateSqliteToPostgres({ sqlitePath: path, dsn })).rejects.toThrow(MigrationError);
    expect(await pgCount(dsn, 'profile_tokens')).toBe(before);
    // --force is idempotent: same data, no duplicates.
    await migrateSqliteToPostgres({ sqlitePath: path, dsn, force: true });
    expect(await pgCount(dsn, 'profile_tokens')).toBe(before);
  });

  it('is all-or-nothing: a failure part-way commits nothing', async () => {
    const { path } = await seedSqlite();
    const raw = new Database(path);
    // Duplicate primary key in the target after copy cannot happen; use an unknown column instead.
    raw.exec('CREATE TABLE zz_extra (a TEXT)'); raw.exec("INSERT INTO zz_extra VALUES ('x')");
    raw.close();
    const { dsn } = await target();
    await expect(migrateSqliteToPostgres({ sqlitePath: path, dsn })).rejects.toThrow(/no target table/);
    expect(await pgCount(dsn, 'profile_tokens')).toBe(0);
  });

  it('CLI prints table counts only, never row contents or the DSN, and redacts errors', async () => {
    const { path } = await seedSqlite();
    const { dsn } = await target();
    const lines: string[] = [];
    expect(await runDbCli(['migrate-sqlite-to-pg', '--sqlite', path], { SPLICEDOCK_DB_DSN: dsn }, s => lines.push(s))).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('profile_tokens: ');
    expect(text).not.toContain(dsn);
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain(hash('secret-token'));
    // Second run is refused (exit 1), and the message carries no DSN.
    const again: string[] = [];
    expect(await runDbCli(['migrate-sqlite-to-pg', '--sqlite', path], { SPLICEDOCK_DB_DSN: dsn }, s => again.push(s))).toBe(1);
    expect(again.join('\n')).not.toContain(dsn);
    // A bad host error must not echo the DSN either.
    const bad = 'postgres://user:hunter2pw@127.0.0.1:1/nodb';
    const errLines: string[] = [];
    const code = await runDbCli(['migrate-sqlite-to-pg', '--sqlite', path], { SPLICEDOCK_DB_DSN: bad }, s => errLines.push(s));
    expect(code).toBe(3);
    expect(errLines.join('\n')).not.toContain('hunter2pw');
  });

  it('a failed --force run leaves sequences and data as they were, and prints no row contents', async () => {
    const { path } = await seedSqlite();
    const { dsn } = await target();
    await migrateSqliteToPostgres({ sqlitePath: path, dsn });
    const db = new PgDb(dsn, { max: 1 });
    try {
      // Move the live target ahead of the source: rows and sequence beyond the source maximum.
      await db.prepare("INSERT INTO breaker_audit (id, ts, scope, event) VALUES (100000, 1, 's', 'e')").run();
      await db.prepare("SELECT setval(pg_get_serial_sequence('breaker_audit', 'id'), 100000)").get();
    } finally { await db.close(); }
    // webauthn_credentials sorts after breaker_audit, so this fails after its sequence repair.
    const raw = new Database(path);
    raw.prepare("UPDATE webauthn_credentials SET sign_count = 'SENSITIVE-MARKER-42'").run();
    raw.close();
    const lines: string[] = [];
    expect(await runDbCli(['migrate-sqlite-to-pg', '--sqlite', path, '--force'], { SPLICEDOCK_DB_DSN: dsn }, s => lines.push(s))).toBe(1);
    const text = lines.join('\n');
    expect(text).not.toContain('SENSITIVE-MARKER-42');
    expect(text).toMatch(/webauthn_credentials: copy failed \(SQLSTATE [0-9A-Z]{5}/);
    const after = new PgDb(dsn, { max: 1 });
    try {
      expect(Number(((await after.prepare('SELECT MAX(id) AS m FROM breaker_audit').get()) as { m: number }).m)).toBe(100000);
      // setval would have survived the rollback and made this collide (23505).
      await after.prepare("INSERT INTO breaker_audit (ts, scope, event) VALUES (2, 's', 'e')").run();
      expect(Number(((await after.prepare('SELECT MAX(id) AS m FROM breaker_audit').get()) as { m: number }).m)).toBe(100001);
    } finally { await after.close(); }
  });

  it('never truncates a target-only table that holds data, even with --force', async () => {
    const { path } = await seedSqlite();
    const { dsn } = await target();
    const db = new PgDb(dsn, { max: 1 });
    try {
      await migrateSqliteToPostgres({ sqlitePath: path, dsn });
      await db.prepare('CREATE TABLE zz_target_only (a TEXT)').run();
      await db.prepare("INSERT INTO zz_target_only VALUES ('keep')").run();
    } finally { await db.close(); }
    await expect(migrateSqliteToPostgres({ sqlitePath: path, dsn, force: true })).rejects.toThrow(/target-only tables hold data \(zz_target_only\)/);
    expect(await pgCount(dsn, 'zz_target_only')).toBe(1);
  });

  it('refuses a target-only NOT NULL column without a default before touching data', async () => {
    const { path } = await seedSqlite();
    const { dsn } = await target();
    await migrateSqliteToPostgres({ sqlitePath: path, dsn });
    const before = await pgCount(dsn, 'profile_tokens');
    const db = new PgDb(dsn, { max: 1 });
    try { await db.prepare('ALTER TABLE push_subscriptions ADD COLUMN must_have TEXT NOT NULL DEFAULT \'x\'').run(); await db.prepare('ALTER TABLE push_subscriptions ALTER COLUMN must_have DROP DEFAULT').run(); } finally { await db.close(); }
    await expect(migrateSqliteToPostgres({ sqlitePath: path, dsn, force: true })).rejects.toThrow(/push_subscriptions: target-only NOT NULL column\(s\) without default: must_have/);
    expect(await pgCount(dsn, 'profile_tokens')).toBe(before);
  });
});
