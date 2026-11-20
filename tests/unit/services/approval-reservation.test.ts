// R6: consuming an approval is two-phase. The evaluator hook only RESERVES the
// approved row; the wrapper FINALIZES it once the child process has spawned,
// or RELEASES it after a confirmed pre-spawn failure. Nothing is ever refunded
// after a spawn, and a reservation that is never settled expires.
import { beforeEach, describe, expect, it } from 'vitest';

import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';
import { ApprovalService, type ApprovalEvent } from '../../../src/application/approvals/approval-service.js';

const INPUT = { tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths' as const, matched: 'rollout undo' };
const CALLER = { profile: 'profA', tokenId: 'tok-1', authenticated: true };
const CWD = '/srv/placeholder/workspace';

describe('ApprovalService: reserve, finalize, release', () => {
  let store: SplicedockStore;
  let svc: ApprovalService;
  let now: number;
  let events: ApprovalEvent[];

  const hook = () => svc.makeHook('kubectl', CWD, CALLER)(INPUT);
  const approved = async (): Promise<string> => {
    const first = await hook();
    expect(first.approved).toBe(false);
    if (first.approved || !('id' in first)) throw new Error('expected a pending row');
    expect(await svc.approve(first.id, 'op')).toBe(true);
    return first.id;
  };

  beforeEach(async () => {
    now = 1_000_000;
    events = [];
    store = await SplicedockStore.open(':memory:');
    svc = new ApprovalService({
      store,
      ttlMs: 600_000,
      reservationTtlMs: 120_000,
      sweepIntervalMs: 0,
      now: () => now,
      onEvent: (_tool, e) => events.push(e),
    });
  });

  it('the hook reserves the approved row instead of consuming it', async () => {
    const id = await approved();
    expect(await hook()).toEqual({ approved: true, id });
    const row = (await svc.get(id))!;
    expect(row.status).toBe('reserved');
    expect(row.consumed_at).toBeNull();
    expect(events).not.toContain('consumed');
  });

  it('a reserved row cannot be reserved a second time', async () => {
    const id = await approved();
    expect(await hook()).toEqual({ approved: true, id });
    const second = await hook();
    expect(second.approved).toBe(false);
    expect('id' in second && second.id).not.toBe(id);
    expect((await svc.get(id))?.status).toBe('reserved');
  });

  it('finalize marks the row consumed exactly once', async () => {
    const id = await approved();
    await hook();
    now += 10;
    expect(await svc.finalize(id)).toBe(true);
    const row = (await svc.get(id))!;
    expect(row.status).toBe('consumed');
    expect(row.consumed_at).toBe(now);
    expect(events.filter(e => e === 'consumed')).toHaveLength(1);
    expect(await svc.finalize(id)).toBe(false);
    expect(events.filter(e => e === 'consumed')).toHaveLength(1);
  });

  it('release returns a reserved row to approved so the same caller can retry', async () => {
    const id = await approved();
    await hook();
    expect(await svc.release(id)).toBe(true);
    expect((await svc.get(id))?.status).toBe('approved');
    expect(events).toContain('released');
    expect(await hook()).toEqual({ approved: true, id });
  });

  it('a finalized approval is never refunded', async () => {
    const id = await approved();
    await hook();
    expect(await svc.finalize(id)).toBe(true);
    expect(await svc.release(id)).toBe(false);
    expect((await svc.get(id))?.status).toBe('consumed');
    expect((await hook()).approved).toBe(false);
  });

  it('settling a row that was never reserved does nothing', async () => {
    const id = await approved();
    expect(await svc.finalize(id)).toBe(false);
    expect(await svc.release(id)).toBe(false);
    expect((await svc.get(id))?.status).toBe('approved');
    expect(await svc.finalize('no-such-id')).toBe(false);
  });

  it('a stale reservation expires and is never reverted', async () => {
    const id = await approved();
    await hook();
    now += 119_999;
    expect(await svc.sweep()).toBe(0);
    expect((await svc.get(id))?.status).toBe('reserved');
    now += 1;
    expect(await svc.sweep()).toBe(1);
    expect((await svc.get(id))?.status).toBe('expired');
    expect(events).toContain('expired');
    expect(await svc.release(id)).toBe(false);
    expect(await svc.finalize(id)).toBe(false);
    expect((await svc.get(id))?.status).toBe('expired');
  });

  it('the approval TTL does not expire a live reservation, so a late spawn still finalizes', async () => {
    const local = new ApprovalService({
      store,
      ttlMs: 1_000,
      reservationTtlMs: 120_000,
      sweepIntervalMs: 0,
      now: () => now,
    });
    const first = await local.makeHook('kubectl', CWD, CALLER)(INPUT);
    if (first.approved || !('id' in first)) throw new Error('expected a pending row');
    await local.approve(first.id, 'op');
    expect(await local.makeHook('kubectl', CWD, CALLER)(INPUT)).toEqual({ approved: true, id: first.id });
    now += 5_000; // past expires_at, within the reservation TTL
    expect(await local.sweep()).toBe(0);
    expect(await local.finalize(first.id)).toBe(true);
    expect((await local.get(first.id))?.status).toBe('consumed');
  });

  it('the stale-reservation sweep also runs from the hook path', async () => {
    const id = await approved();
    await hook();
    now += 120_000;
    // A new call sweeps first: the stale row expires and a new pending row is created.
    const next = await hook();
    expect(next.approved).toBe(false);
    expect((await svc.get(id))?.status).toBe('expired');
  });
});
