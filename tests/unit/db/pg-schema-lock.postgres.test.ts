import { describe, it, expect, afterAll } from 'vitest';
import { PgDb } from '../../../src/adapters/outbound/persistence/pg-db.js';
import { migratePostgres } from '../../../src/adapters/outbound/persistence/pg-schema.js';
import { TEST_PG_DSN, PG_SKIP_REASON, createIsolatedSchema, type IsolatedSchema } from '../../helpers/pg-test.js';

const LOCK_KEY = 727274;
const schemas: IsolatedSchema[] = [];
afterAll(async () => { await Promise.all(schemas.map((s) => s.drop())); });

async function freshDsn(): Promise<string> {
  const s = await createIsolatedSchema(TEST_PG_DSN!);
  schemas.push(s);
  return s.dsn;
}

async function advisoryHeld(db: PgDb): Promise<number> {
  const row = await db.prepare("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=? AND granted").get(LOCK_KEY) as { n: number };
  return row.n;
}

describe.skipIf(!TEST_PG_DSN)(TEST_PG_DSN ? 'migratePostgres lock (Postgres)' : `migratePostgres lock (Postgres) [skipped: ${PG_SKIP_REASON}]`, () => {
  it('two replicas migrating at once both succeed and leave no advisory lock behind', async () => {
    const dsn = await freshDsn();
    const a = new PgDb(dsn);
    const b = new PgDb(dsn);
    try {
      await Promise.all([migratePostgres(a), migratePostgres(b)]);
      const seeded = await a.prepare("SELECT count(*)::int AS n FROM grant_exceptions WHERE added_by='default'").get() as { n: number };
      expect(seeded.n).toBe(3);
      expect(await advisoryHeld(a)).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('waiting for the lock is not cut short by the pool statement/lock timeout', async () => {
    const dsn = await freshDsn();
    const holder = new PgDb(dsn);
    const booting = new PgDb(dsn, { statementTimeoutMs: 200 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const held = new Promise<void>((r) => { locked = r; });
    try {
      const holding = holder.transaction(async () => {
        await holder.prepare('SELECT pg_advisory_xact_lock(?)').get(LOCK_KEY);
        locked();
        await gate;
      })();
      await held;
      const migrating = migratePostgres(booting);
      await new Promise((r) => setTimeout(r, 600)); // well past the 200ms pool timeout
      release();
      await holding;
      await expect(migrating).resolves.toBeUndefined();
      expect(await advisoryHeld(holder)).toBe(0);
    } finally {
      release();
      await holder.close();
      await booting.close();
    }
  });
});
