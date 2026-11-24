// Cross-replica mutex for periodic sweeps. With 2+ replicas on one Postgres,
// every replica's timer fires; the one that wins pg_try_advisory_lock runs the
// sweep and the rest skip that tick. SQLite is single-process, so it always runs.
import type { SqlDb } from '../base.js';
import { logger } from '../../../common/logger.js';

// Stable per-sweep keys. Distinct from the schema-migration key (727274) in postgres/schema.ts.
// Retired keys, never reuse: 727283 (the removed repo_delete broker, #29),
// 727284 (the removed LinkedIn import).
export const SWEEP_LOCK_KEYS = {
  tokenInactivity: 727281,
  approvalExpiry: 727282,
} as const;

export type SweepName = keyof typeof SWEEP_LOCK_KEYS;

/** Run `fn` if this replica holds the sweep lock; returns undefined when another replica does. */
export async function runSweepExclusive<T>(db: SqlDb, name: SweepName, fn: () => Promise<T>): Promise<T | undefined> {
  const out = await db.tryWithAdvisoryLock(SWEEP_LOCK_KEYS[name], fn);
  if (!out.ran) {
    logger.debug('sweep skipped: lock held by another replica', { sweep: name });
    return undefined;
  }
  return out.value;
}
