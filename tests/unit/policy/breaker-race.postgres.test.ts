import { describe, it, expect, afterEach } from 'vitest';
import { PgDb } from '../../../src/services/database/adapters/postgres/db.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { CircuitBreaker } from '../../../src/services/policy/circuit-breaker.js';
import { TEST_PG_DSN, PG_SKIP_REASON, createIsolatedSchema, holdRowLocks, untilLockWaiters, type IsolatedSchema } from '../../helpers/pg-test.js';

// Two PgDb pools on one schema stand in for two Splicedock replicas.
const cfg = { enabled: true, mode: 'enforce' as const, window_seconds: 60, deny_threshold: 100, cooldown_seconds: 1800, half_open_probes: 3, scopes: ['global'], read_allowlist: [] };
const open: Array<{ close(): Promise<void> }> = [];
const schemas: IsolatedSchema[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
  for (const s of schemas.splice(0)) await s.drop();
});

async function replicas(overrides: Partial<typeof cfg> = {}) {
  const s = await createIsolatedSchema(TEST_PG_DSN!); schemas.push(s);
  const storeA = await SplicedockStore.open(s.dsn); const storeB = await SplicedockStore.open(s.dsn);
  const raw = new PgDb(s.dsn);
  open.push(storeA, storeB, raw);
  const a = await CircuitBreaker.create(storeA.consentDatabase(), { ...cfg, ...overrides });
  const b = await CircuitBreaker.create(storeB.consentDatabase(), { ...cfg, ...overrides });
  return { a, b, raw };
}
async function state(db: PgDb): Promise<{ state: string; denials: number }> {
  return await db.prepare("SELECT state, denials FROM breaker_state WHERE scope='global'").get() as { state: string; denials: number };
}

describe.skipIf(!TEST_PG_DSN)(TEST_PG_DSN ? 'circuit breaker races (Postgres)' : `circuit breaker races (Postgres) [skipped: ${PG_SKIP_REASON}]`, () => {
  it('a trip is not lost to a concurrent record() that read the row before it', async () => {
    const { a, b, raw } = await replicas();
    await a.record(undefined, false); // create the global row
    // Hold the row so both writers queue behind it in a fixed order.
    const holder = holdRowLocks(raw, "SELECT 1 FROM breaker_state WHERE scope='global' FOR UPDATE");
    await holder.held;
    const trip = a.control('global', true, 'operator');
    await untilLockWaiters(raw, 1);
    const rec = b.record(undefined, false);
    await untilLockWaiters(raw, 2);
    await holder.release();
    await Promise.all([trip, rec]);
    expect((await state(raw)).state).toBe('open');
  });

  it('concurrent first use from two replicas initialises the row once and loses no denial', async () => {
    const { a, b, raw } = await replicas();
    const calls = Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).record(undefined, true));
    const settled = await Promise.allSettled(calls);
    expect(settled.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await state(raw)).toEqual({ state: 'closed', denials: 20 });
  });

  it('denials racing across replicas trip the breaker exactly at the threshold', async () => {
    const { a, b, raw } = await replicas({ deny_threshold: 6 });
    await a.record(undefined, false);
    await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).record(undefined, true)));
    expect((await state(raw)).state).toBe('open');
  });
});
