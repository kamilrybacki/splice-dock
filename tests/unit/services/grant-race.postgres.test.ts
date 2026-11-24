import { describe, it, expect, afterEach } from 'vitest';
import { PgDb } from '../../../src/services/database/adapters/postgres/db.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';
import { builtinShapes } from '../../../src/services/policy/builtin.js';
import { TEST_PG_DSN, PG_SKIP_REASON, createIsolatedSchema, holdRowLocks, untilLockWaiters, type IsolatedSchema } from '../../helpers/pg-test.js';

// Two ApprovalService instances, each on its own SplicedockStore pool over one
// schema, stand in for two Splicedock replicas sharing a standing grant.
const caller = { profile: 'test', tokenId: 'fixture', authenticated: true };
const context = 'Clean up completed batch jobs after investigating failed scheduled runs';
const open: Array<{ close(): Promise<void> }> = [];
const schemas: IsolatedSchema[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
  for (const s of schemas.splice(0)) await s.drop();
});

async function replicas() {
  const s = await createIsolatedSchema(TEST_PG_DSN!); schemas.push(s);
  const storeA = await SplicedockStore.open(s.dsn); const storeB = await SplicedockStore.open(s.dsn);
  const raw = new PgDb(s.dsn);
  open.push(storeA, storeB, raw);
  const now = () => Date.now();
  const svcA = new ApprovalService({ store: storeA, grantsEnabled: true, shapes: builtinShapes, sweepIntervalMs: 0, now });
  const svcB = new ApprovalService({ store: storeB, grantsEnabled: true, shapes: builtinShapes, sweepIntervalMs: 0, now });
  const request = (svc: ApprovalService, name: string) =>
    svc.makeHook('kubectl', '/workspace', caller, false, context)({ tool: 'kubectl', argv: ['delete', 'job', name, '-n', 'batch'], rule: 'approval_subcommands', matched: 'delete' });
  // Manually approve, reserve and consume one operation; returns the consumed id.
  const consumed = async (svc: ApprovalService, name: string) => {
    const out = await request(svc, name); await svc.approve(out.id!, 'operator');
    const approved = await request(svc, name); expect(approved.approved).toBe(true);
    await svc.finalize(approved.id!); return approved.id!;
  };
  const execute = async (svc: ApprovalService, name: string) => { await svc.executionResult(await consumed(svc, name), true); };
  return { svcA, svcB, raw, request, consumed, execute };
}

async function grants(raw: PgDb) {
  return await raw.prepare('SELECT id,use_count,use_count_max FROM standing_grants').all() as Array<{ id: string; use_count: number; use_count_max: number }>;
}
async function grantApproved(raw: PgDb): Promise<number> {
  return (await raw.prepare("SELECT id FROM pending_approvals WHERE consent_method='grant' AND status IN ('approved','reserved','consumed')").all()).length;
}
/** Promote one grant on replica A and leave it a single use. */
async function oneUseGrant(r: Awaited<ReturnType<typeof replicas>>) {
  await r.execute(r.svcA, 'one'); await r.execute(r.svcA, 'two');
  const [g] = await grants(r.raw); expect(g).toBeDefined();
  await r.raw.prepare('UPDATE standing_grants SET use_count_max=1 WHERE id=?').run(g!.id);
  return g!.id;
}

describe.skipIf(!TEST_PG_DSN)(TEST_PG_DSN ? 'standing grant races (Postgres)' : `standing grant races (Postgres) [skipped: ${PG_SKIP_REASON}]`, () => {
  it('a one-use grant approves at most one of two interleaved requests', async () => {
    const r = await replicas(); const id = await oneUseGrant(r);
    // Park both replicas on the grant row after they have matched it.
    const holder = holdRowLocks(r.raw, `SELECT 1 FROM standing_grants WHERE id='${id}' FOR UPDATE`);
    await holder.held;
    const pa = r.request(r.svcA, 'x'); const pb = r.request(r.svcB, 'y');
    await untilLockWaiters(r.raw, 2);
    await holder.release();
    const results = await Promise.all([pa, pb]);
    expect(results.filter((o) => o.approved)).toHaveLength(1);
    expect((await grants(r.raw))[0]!.use_count).toBe(1);
    expect(await grantApproved(r.raw)).toBe(1);
  });

  it('a rejection queued before a grant claim is retained without lock inversion', async () => {
    const r = await replicas();
    const pending = await r.request(r.svcA, 'x');
    const id = await oneUseGrant(r);
    const holder = holdRowLocks(r.raw, `SELECT 1 FROM pending_approvals WHERE id='${pending.id}' FOR UPDATE`);
    await holder.held;
    const rejection = r.svcB.reject(pending.id!, 'operator');
    await untilLockWaiters(r.raw, 1);
    const request = r.request(r.svcA, 'x');
    const settled = Promise.allSettled([rejection, request]);
    await untilLockWaiters(r.raw, 2);
    await holder.release();
    const results = await settled;
    expect(results[0]).toEqual({ status: 'fulfilled', value: true });
    expect(results[1].status).toBe('fulfilled');
    expect((await r.svcA.get(pending.id!))?.status).toBe('rejected');
    expect(await r.raw.prepare('SELECT revoked_at FROM standing_grants WHERE id=?').get(id)).toMatchObject({ revoked_at: expect.any(Number) });
    expect((await grants(r.raw))[0]!.use_count).toBe(0);
  });

  it('two unforced concurrent requests never exceed use_count_max', async () => {
    const r = await replicas(); await oneUseGrant(r);
    const results = await Promise.all([r.request(r.svcA, 'x'), r.request(r.svcB, 'y')]);
    expect(results.filter((o) => o.approved).length).toBeLessThanOrEqual(1);
    expect((await grants(r.raw))[0]!.use_count).toBeLessThanOrEqual(1);
  });

  it.each(['revoked_at', 'suspended_at'])('a grant %s between match and consume is not used', async (column) => {
    const r = await replicas(); await r.execute(r.svcA, 'one'); await r.execute(r.svcA, 'two');
    const [g] = await grants(r.raw);
    const holder = holdRowLocks(r.raw, `SELECT 1 FROM standing_grants WHERE id='${g!.id}' FOR UPDATE`);
    await holder.held;
    const revoke = r.raw.prepare(`UPDATE standing_grants SET ${column}=? WHERE id=?`).run(Date.now(), g!.id);
    await untilLockWaiters(r.raw, 1);
    const pending = r.request(r.svcB, 'x');
    await untilLockWaiters(r.raw, 2);
    await holder.release();
    await revoke;
    const out = await pending;
    expect(out.approved).toBe(false);
    expect((await grants(r.raw))[0]!.use_count).toBe(0);
    expect(await grantApproved(r.raw)).toBe(0);
  });

  it('concurrent promotions on two replicas create one grant', async () => {
    const r = await replicas(); await r.execute(r.svcA, 'one');
    const a = await r.consumed(r.svcA, 'two'); const b = await r.consumed(r.svcB, 'three');
    // Hold both consumed rows so both executionResult calls start together.
    const holder = holdRowLocks(r.raw, `SELECT 1 FROM pending_approvals WHERE id IN ('${a}','${b}') FOR UPDATE`);
    await holder.held;
    const pa = r.svcA.executionResult(a, true); const pb = r.svcB.executionResult(b, true);
    await untilLockWaiters(r.raw, 2);
    await holder.release();
    await Promise.all([pa, pb]);
    expect(await grants(r.raw)).toHaveLength(1);
  });

  it('sequential grant use still works up to the limit', async () => {
    const r = await replicas(); await oneUseGrant(r);
    expect((await r.request(r.svcA, 'x')).approved).toBe(true);
    expect((await r.request(r.svcB, 'y')).approved).toBe(false);
  });
});
