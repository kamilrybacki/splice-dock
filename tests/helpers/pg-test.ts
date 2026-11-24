import { randomBytes } from 'node:crypto';
import { PgDb } from '../../src/services/database/adapters/postgres/db.js';

/** DSN of a real Postgres for tests; absent => the real-Postgres suites skip. */
export const TEST_PG_DSN = process.env['SPLICEDOCK_TEST_PG_DSN'];
export const PG_SKIP_REASON =
  'SPLICEDOCK_TEST_PG_DSN not set: real-Postgres concurrency tests need a reachable Postgres';

// CI sets SPLICEDOCK_REQUIRE_PG_TESTS=1 so a missing DSN fails the run instead
// of silently skipping the race suites.
if (process.env['SPLICEDOCK_REQUIRE_PG_TESTS'] === '1' && !TEST_PG_DSN) {
  throw new Error('SPLICEDOCK_REQUIRE_PG_TESTS=1 but SPLICEDOCK_TEST_PG_DSN is not set');
}

export interface IsolatedSchema { dsn: string; drop(): Promise<void> }

/** Create a throwaway schema and return a DSN whose search_path is pinned to it. */
export async function createIsolatedSchema(baseDsn: string): Promise<IsolatedSchema> {
  const schema = `splicedock_test_${randomBytes(6).toString('hex')}`;
  const admin = new PgDb(baseDsn);
  await admin.exec(`CREATE SCHEMA ${schema}`);
  await admin.close();
  const sep = baseDsn.includes('?') ? '&' : '?';
  // application_name tags every session of this schema so lock-waiter counts
  // (untilLockWaiters) stay scoped to one test.
  const dsn = `${baseDsn}${sep}options=${encodeURIComponent(`-csearch_path=${schema}`)}&application_name=${schema}`;
  return {
    dsn,
    async drop() {
      const a = new PgDb(baseDsn);
      await a.exec(`DROP SCHEMA ${schema} CASCADE`);
      await a.close();
    },
  };
}

export interface RowLockHolder {
  /** Resolves once the holder transaction has the row locks. */
  held: Promise<void>;
  /** Commits the holder transaction; resolves when it has finished. */
  release(): Promise<void>;
}

/**
 * Take row locks in a separate transaction on `db` and keep them until
 * release(), so contenders queue behind it in a known order. `lockSql` must be
 * a SELECT ... FOR UPDATE.
 */
export function holdRowLocks(db: PgDb, lockSql: string): RowLockHolder {
  let open!: () => void;
  let gotLocks!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const held = new Promise<void>((r) => { gotLocks = r; });
  const done = db.transaction(async () => {
    await db.prepare(lockSql).all();
    gotLocks();
    await gate;
  })();
  // Surface a holder failure through `held` instead of leaving the test hanging.
  done.catch(() => undefined);
  const heldOrFailed = Promise.race([held, done.then(() => { throw new Error('row-lock holder ended before locking'); })]);
  return { held: heldOrFailed, release: async () => { open(); await done; } };
}

/**
 * Wait until at least `n` sessions of this isolated schema (same
 * application_name, see createIsolatedSchema) are waiting on a lock, so race
 * suites running in parallel against one database never see each other's waiters.
 */
export async function untilLockWaiters(db: PgDb, n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const row = await db.prepare("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND application_name=current_setting('application_name')").get() as { n: number };
    if (row.n >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`expected ${n} lock waiters`);
}
