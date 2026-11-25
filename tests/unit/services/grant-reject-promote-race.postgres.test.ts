import { describe, it, expect, afterEach } from 'vitest';
import { PgDb } from '../../../src/services/database/adapters/postgres/db.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';
import { builtinShapes } from '../../../src/builtin-backends.js';
import { TEST_PG_DSN, PG_SKIP_REASON, createIsolatedSchema, holdRowLocks, untilLockWaiters, type IsolatedSchema } from '../../helpers/pg-test.js';

const caller = { profile: 'test', tokenId: 'fixture', authenticated: true };
const context = 'Clean up completed batch jobs after investigating failed scheduled runs';
const open: Array<{ close(): Promise<void> }> = [];
const schemas: IsolatedSchema[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
  for (const s of schemas.splice(0)) await s.drop();
});

describe.skipIf(!TEST_PG_DSN)(TEST_PG_DSN ? 'rejection vs promotion race (Postgres)' : `rejection vs promotion race (Postgres) [skipped: ${PG_SKIP_REASON}]`, () => {
  it('a rejection racing a promotion never leaves a live grant behind', async () => {
    const s = await createIsolatedSchema(TEST_PG_DSN!); schemas.push(s);
    const storeA = await SplicedockStore.open(s.dsn); const storeB = await SplicedockStore.open(s.dsn);
    const raw = new PgDb(s.dsn); open.push(storeA, storeB, raw);
    const now = () => Date.now();
    const svcA = new ApprovalService({ store: storeA, grantsEnabled: true, shapes: builtinShapes, sweepIntervalMs: 0, now });
    const svcB = new ApprovalService({ store: storeB, grantsEnabled: true, shapes: builtinShapes, sweepIntervalMs: 0, now });
    const request = (svc: ApprovalService, name: string) =>
      svc.makeHook('kubectl', '/workspace', caller, false, context)({ tool: 'kubectl', argv: ['delete', 'job', name, '-n', 'batch'], rule: 'approval_subcommands', matched: 'delete' });
    const consumed = async (name: string) => {
      const out = await request(svcA, name); await svcA.approve(out.id!, 'operator');
      const approved = await request(svcA, name); await svcA.finalize(approved.id!); return approved.id!;
    };
    // One executed approval, one consumed-but-unreported approval whose result
    // report will trigger promotion, and one pending approval to reject.
    await svcA.executionResult(await consumed('one'), true);
    const second = await consumed('two');
    const pending = await request(svcA, 'x');
    // Stall the promotion's INSERT (after its block check) behind a test-only
    // trigger that waits on an advisory lock this holder owns.
    await raw.exec(`CREATE FUNCTION stall_grant_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(424242); RETURN NEW; END $$;
      CREATE TRIGGER stall_grant_insert BEFORE INSERT ON standing_grants FOR EACH ROW EXECUTE FUNCTION stall_grant_insert()`);
    const holder = holdRowLocks(raw, 'SELECT pg_advisory_xact_lock(424242)');
    await holder.held;
    const promotion = svcA.executionResult(second, true);
    await untilLockWaiters(raw, 1);
    const rejection = svcB.reject(pending.id!, 'operator');
    // Unfixed code lets the rejection finish while the promotion is parked;
    // fixed code parks it behind the promotion's per-identity lock.
    await Promise.race([rejection.catch(() => undefined), new Promise((r) => setTimeout(r, 300))]);
    await holder.release();
    await Promise.all([promotion, rejection]);
    const live = await raw.prepare('SELECT count(*)::int AS n FROM standing_grants WHERE revoked_at IS NULL').get() as { n: number };
    expect(live.n).toBe(0);
    expect((await raw.prepare('SELECT count(*)::int AS n FROM grant_blocks').get() as { n: number }).n).toBeGreaterThan(0);
  });
});
