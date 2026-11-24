import { describe, it, expect, vi } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';
import type { SqliteDb } from "../../../src/services/database/adapters/sqlite/db.js";
const caller = { profile: 'test', tokenId: 'test-token', authenticated: true };
describe('approval wait', () => {
  it('returns only caller-bound decisions and preserves late approved retries', async () => {
    let now = 1000;
    const store = await SplicedockStore.open(':memory:');
    const svc = new ApprovalService({ store, now: () => now, ttlMs: 10000, sweepIntervalMs: 0 });
    const hook = svc.makeHook('kubectl', '/workspace', caller);
    const input = { tool: 'kubectl', argv: ['delete', 'job', 'fixture'], rule: 'approval_subcommands' as const, matched: 'delete' };
    const out = await hook(input);
    expect(await svc.wait(out.id!, 0, caller)).toBe('pending');
    for (const foreign of [undefined, { ...caller, authenticated: false }, { ...caller, profile: 'other' }, { ...caller, tokenId: 'other' }]) {
      await expect(svc.wait(out.id!, 0, foreign)).rejects.toThrow('approval not found');
    }
    await svc.approve(out.id!, 'operator'); now += 9000;
    expect(await svc.wait(out.id!, 0, caller)).toBe('approved');
    expect((await hook(input)).approved).toBe(true); await svc.finalize(out.id!);
    expect(await svc.wait(out.id!, 0, caller)).toBe('consumed');
    await store.close();
  });
  it('waits for a decision, caps timeout and expires overdue rows', async () => {
    vi.useFakeTimers();
    const store = await SplicedockStore.open(':memory:');
    const svc = new ApprovalService({ store, sweepIntervalMs: 0, ttlMs: 200000 });
    const out = await svc.makeHook('kubectl', '/workspace', caller)({tool:'kubectl',argv:['delete'],rule:'approval_subcommands',matched:'delete'});
    const pending = svc.wait(out.id!, 999, caller);
    await vi.advanceTimersByTimeAsync(120000); expect(await pending).toBe('pending');
    const rejected = svc.wait(out.id!, 10, caller); await svc.reject(out.id!, 'operator');
    await vi.advanceTimersByTimeAsync(250); expect(await rejected).toBe('rejected');
    await store.close(); vi.useRealTimers();
  });
  it('aborts promptly, bounds per-token waits, and releases slots', async () => {
    const store = await SplicedockStore.open(':memory:');
    const svc = new ApprovalService({store, sweepIntervalMs:0});
    const out = await svc.makeHook('kubectl','/workspace',caller)({tool:'kubectl',argv:['delete'],rule:'approval_subcommands',matched:'delete'});
    const abort = new AbortController();
    const waits = [svc.wait(out.id!,120,caller,abort.signal),svc.wait(out.id!,120,caller,abort.signal)];
    const settled = Promise.allSettled(waits);
    await expect(svc.wait(out.id!,120,caller)).rejects.toThrow('too many');
    abort.abort();
    expect((await settled).every(r => r.status === 'rejected')).toBe(true);
    expect(await svc.wait(out.id!,0,caller)).toBe('pending');
    await store.close();
  });
  it('computes expiry without writes and reports reservations in use', async () => {
    let now = 1000;
    const store = await SplicedockStore.open(':memory:');
    const svc = new ApprovalService({store,now:()=>now,ttlMs:1000,reservationTtlMs:100,sweepIntervalMs:0});
    const hook = svc.makeHook('kubectl','/workspace',caller);
    const input = {tool:'kubectl',argv:['delete'],rule:'approval_subcommands' as const,matched:'delete'};
    const out = await hook(input); await svc.approve(out.id!,'operator'); await hook(input);
    const db = (store.consentDatabase() as SqliteDb).raw;
    db.pragma('query_only = ON');
    expect(await svc.wait(out.id!,0,caller)).toBe('in_use');
    now += 101;
    expect(await svc.wait(out.id!,0,caller)).toBe('expired');
    expect((await store.getApproval(out.id!))!.status).toBe('reserved');
    db.pragma('query_only = OFF');
    const next = await hook({...input,argv:['delete','job']});
    db.pragma('query_only = ON');
    expect(await svc.wait(next.id!,0.02,caller)).toBe('pending');
    now += 1001;
    db.pragma('query_only = ON');
    expect(await svc.wait(next.id!,0,caller)).toBe('expired');
    expect((await store.getApproval(next.id!))!.status).toBe('pending');
    await store.close();
  });

});
