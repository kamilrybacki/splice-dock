/**
 * One-shot SQLite -> Postgres data migration.
 *
 * Copies every table in a single Postgres transaction, preserving ids and
 * timestamps, then repairs serial sequences (transactionally, via ALTER
 * SEQUENCE ... RESTART) and checks per-table row counts. Any failure rolls the
 * whole copy back. Only the idempotent schema creation/upgrade runs before the
 * data transaction. Output and errors carry table/column names, counts and
 * SQLSTATE codes only: never row contents, never the DSN.
 */
import Database from 'better-sqlite3';
import pg from 'pg';
import { PgDb } from './pg-db.js';
import { migratePostgres } from './pg-schema.js';
import { isPostgresDsn } from '../../../ports/sql-db.js';

export interface MigrateOptions {
  sqlitePath: string;
  dsn: string;
  /** Overwrite a non-empty target instead of refusing. */
  force?: boolean;
}

export interface MigrateReport {
  tables: ReadonlyArray<{ table: string; rows: number }>;
  totalRows: number;
}

/** Rows created by schema migration itself; they do not make a target "non-empty". */
const SEED_FILTERS: Readonly<Record<string, string>> = {
  breaker_migrations: "version <> 'strong-recovery-v1'",
  grant_settings: "key <> 'exceptions_seeded'",
  grant_exceptions: "NOT (tool = 'kubectl' AND verb_path IN ('drain','cordon','uncordon'))",
};

const MAX_PARAMS = 60_000;
const MAX_BATCH_ROWS = 500;

export class MigrationError extends Error {}

/** A driver error re-thrown with safe context only (table, column, SQLSTATE). */
function safeError(table: string, stage: string, err: unknown): MigrationError {
  if (err instanceof MigrationError) return err;
  const e = err as { code?: unknown; column?: unknown };
  const code = typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : 'unknown';
  const column = typeof e?.column === 'string' && /^[A-Za-z0-9_]+$/.test(e.column) ? `, column ${e.column}` : '';
  return new MigrationError(`table ${table}: ${stage} failed (SQLSTATE ${code}${column})`);
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

/** Strip the DSN (and its password) from any message before it leaves the process. */
export function redact(message: string, dsn: string): string {
  let out = message.split(dsn).join('<dsn>');
  try {
    const u = new URL(dsn);
    for (const secret of [u.password, decodeURIComponent(u.password)]) {
      if (secret) out = out.split(secret).join('<redacted>');
    }
  } catch { /* not parseable: the literal replacement above is all we can do */ }
  return out;
}

/** Tables of removed features: older SQLite files may still hold them, the
 *  Postgres schema no longer creates them, so the copy skips them. */
const RETIRED_TABLES: ReadonlySet<string> = new Set(['linkedin_drafts', 'linkedin_inputs']);

function sqliteTables(raw: Database.Database): string[] {
  return (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    .map(r => r.name)
    .filter(name => !RETIRED_TABLES.has(name));
}

async function pgTables(c: pg.Client): Promise<string[]> {
  const r = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type='BASE TABLE' ORDER BY table_name");
  return r.rows.map((x: { table_name: string }) => x.table_name);
}

interface PgColumn { name: string; required: boolean }

async function pgColumnInfo(c: pg.Client, table: string): Promise<PgColumn[]> {
  const r = await c.query('SELECT column_name, is_nullable, column_default, is_identity FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position', [table]);
  return r.rows.map((x: { column_name: string; is_nullable: string; column_default: string | null; is_identity: string }) => ({
    name: x.column_name,
    required: x.is_nullable === 'NO' && x.column_default === null && x.is_identity !== 'YES',
  }));
}

async function pgColumns(c: pg.Client, table: string): Promise<string[]> {
  return (await pgColumnInfo(c, table)).map(x => x.name);
}

function sqliteColumns(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${q(table)})`).all() as { name: string }[]).map(x => x.name);
}

/**
 * Validate before anything is mutated: every source table and column must
 * exist in the target, and every target-only column must be nullable or
 * defaulted (otherwise the copy could only fail part-way).
 */
async function assertCompatible(raw: Database.Database, c: pg.Client, source: readonly string[], target: readonly string[]): Promise<void> {
  const missing = source.filter(t => !target.includes(t));
  if (missing.length > 0) throw new MigrationError(`source tables with no target table: ${missing.join(', ')}`);
  for (const table of source) {
    const tcols = await pgColumnInfo(c, table);
    const tnames = new Set(tcols.map(x => x.name));
    const scols = sqliteColumns(raw, table);
    const unknown = scols.filter(n => !tnames.has(n));
    if (unknown.length > 0) throw new MigrationError(`table ${table}: column(s) missing in target: ${unknown.join(', ')}`);
    const sset = new Set(scols);
    const required = tcols.filter(x => x.required && !sset.has(x.name)).map(x => x.name);
    if (required.length > 0) throw new MigrationError(`table ${table}: target-only NOT NULL column(s) without default: ${required.join(', ')}`);
  }
}

async function occupiedTables(c: pg.Client, tables: readonly string[]): Promise<string[]> {
  const occupied: string[] = [];
  for (const t of tables) {
    const where = SEED_FILTERS[t];
    const r = await c.query(`SELECT 1 FROM ${q(t)}${where ? ` WHERE ${where}` : ''} LIMIT 1`);
    if ((r.rowCount ?? 0) > 0) occupied.push(t);
  }
  return occupied;
}

async function copyTable(raw: Database.Database, c: pg.Client, table: string): Promise<number> {
  const sourceCols = sqliteColumns(raw, table);
  const cols = sourceCols.map(q).join(', ');
  const batch = Math.max(1, Math.min(MAX_BATCH_ROWS, Math.floor(MAX_PARAMS / sourceCols.length)));
  let total = 0;
  let pending: unknown[][] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const values = pending.map((row, i) => `(${row.map((_, j) => `$${i * sourceCols.length + j + 1}`).join(',')})`).join(',');
    await c.query(`INSERT INTO ${q(table)} (${cols}) VALUES ${values}`, pending.flat());
    total += pending.length;
    pending = [];
  };
  for (const row of raw.prepare(`SELECT ${cols} FROM ${q(table)}`).raw(true).iterate() as Iterable<unknown[]>) {
    pending.push(row);
    if (pending.length >= batch) await flush();
  }
  await flush();
  return total;
}

/**
 * Point every serial/identity column's sequence just past the copied maximum.
 * ALTER SEQUENCE ... RESTART is transactional (unlike setval), so a rollback
 * leaves the target's sequences exactly as they were.
 */
async function fixSequences(c: pg.Client, table: string, columns: readonly string[]): Promise<void> {
  for (const col of columns) {
    const seq = (await c.query('SELECT pg_get_serial_sequence($1, $2) AS s', [q(table), col])).rows[0]?.s as string | null | undefined;
    if (!seq) continue;
    const max = (await c.query(`SELECT MAX(${q(col)})::text AS m FROM ${q(table)}`)).rows[0]?.m as string | null | undefined;
    const next = max == null ? 1n : BigInt(max) + 1n;
    if (next < 1n) throw new MigrationError(`table ${table}: column ${col} holds non-positive ids; cannot place its sequence`);
    // seq is pg_get_serial_sequence output (an already-quoted qualified name); next is a bigint literal.
    await c.query(`ALTER SEQUENCE ${seq} RESTART WITH ${next.toString()}`);
  }
}

export async function migrateSqliteToPostgres(opts: MigrateOptions): Promise<MigrateReport> {
  if (!isPostgresDsn(opts.dsn)) throw new MigrationError('target DSN must be a postgres:// or postgresql:// URL');
  const raw = new Database(opts.sqlitePath, { readonly: true, fileMustExist: true });
  try {
    // Create/upgrade the target schema first (idempotent, own lock + connection).
    const schemaDb = new PgDb(opts.dsn, { max: 1 });
    try { await migratePostgres(schemaDb); } finally { await schemaDb.close(); }

    const client = new pg.Client({ connectionString: opts.dsn, types: { getTypeParser: ((oid: number, f?: 'text' | 'binary') => oid === 20 || oid === 1700 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, f as 'text')) as typeof pg.types.getTypeParser } });
    await client.connect();
    try {
      const source = sqliteTables(raw);
      const target = await pgTables(client);
      const targetOnly = target.filter(t => !source.includes(t));

      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL statement_timeout = 0");
        await client.query(`LOCK TABLE ${target.map(q).join(', ')} IN ACCESS EXCLUSIVE MODE`);
        await assertCompatible(raw, client, source, target);
        // Target-only tables are never truncated. Data there means the source is
        // not the whole picture, so refuse even with --force.
        const strays = await occupiedTables(client, targetOnly);
        if (strays.length > 0) throw new MigrationError(`target-only tables hold data (${strays.join(', ')}); refusing to migrate, even with --force`);
        if (!opts.force) {
          const occupied = await occupiedTables(client, source);
          if (occupied.length > 0) throw new MigrationError(`target is not empty (tables with data: ${occupied.join(', ')}); pass --force to overwrite it`);
        }
        if (source.length > 0) await client.query(`TRUNCATE ${source.map(q).join(', ')}`);

        const tables: { table: string; rows: number }[] = [];
        for (const table of source) {
          let rows: number;
          try {
            rows = await copyTable(raw, client, table);
            await fixSequences(client, table, await pgColumns(client, table));
          } catch (err) { throw safeError(table, 'copy', err); }
          tables.push({ table, rows });
        }
        // Verify before commit: a mismatch rolls everything back.
        for (const { table, rows } of tables) {
          const expected = (raw.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get() as { n: number }).n;
          const actual = Number((await client.query(`SELECT COUNT(*) AS n FROM ${q(table)}`)).rows[0].n);
          if (expected !== rows || actual !== expected) throw new MigrationError(`row count mismatch in ${table}: source ${expected}, target ${actual}`);
        }
        await client.query('COMMIT');
        return { tables, totalRows: tables.reduce((n, t) => n + t.rows, 0) };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  } finally {
    raw.close();
  }
}
