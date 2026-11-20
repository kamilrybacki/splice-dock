import { describe, it, expect, beforeEach } from 'vitest';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';
import { ApprovalService, argvHash } from '../../../src/application/approvals/approval-service.js';

const CWD = '/srv/placeholder/workspace';

describe('argvHash', () => {
  it('binds tool + argv shape', () => {
    expect(argvHash('kubectl', CWD, ['rollout', 'undo'])).not.toEqual(argvHash('kubectl', CWD, ['rollout', 'undo', 'x']));
    expect(argvHash('kubectl', CWD, ['rollout', 'undo'])).toEqual(argvHash('kubectl', CWD, ['rollout', 'undo']));
    expect(argvHash('kubectl', CWD, ['rollout', 'undo'])).not.toEqual(argvHash('gh', CWD, ['rollout', 'undo']));
  });
});

const CALLER = { profile: 'default', tokenId: 'tok-test', authenticated: true };

describe('ApprovalService', () => {
  let store: SplicedockStore;
  let svc: ApprovalService;
  let now: number;

  beforeEach(async () => {
    now = 1_000_000;
    store = await SplicedockStore.open(':memory:');
    svc = new ApprovalService({ store, ttlMs: 600_000, sweepIntervalMs: 0, now: () => now });
  });

  it('first call creates a pending row', async () => {
    const hook = svc.makeHook('kubectl', CWD, CALLER);
    const out = await hook({ tool: 'kubectl', argv: ['rollout', 'undo', 'deploy/x'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    expect(out.approved).toBe(false);
    expect(await svc.list({ status: 'pending' })).toHaveLength(1);
  });

  it('reuses pending row on retry (no duplicate row)', async () => {
    const hook = svc.makeHook('kubectl', CWD, CALLER);
    const a = await hook({ tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    const b = await hook({ tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    expect(a.id).toBe(b.id);
    expect(await svc.list({ status: 'pending' })).toHaveLength(1);
  });

  it('approve → next call with same argv bypasses (one-shot consume)', async () => {
    const hook = svc.makeHook('kubectl', CWD, CALLER);
    const first = await hook({ tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    expect(first.approved).toBe(false);
    expect(await svc.approve(first.id, 'admin')).toBe(true);

    const second = await hook({ tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    expect(second.approved).toBe(true);

    const third = await hook({ tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    expect(third.approved).toBe(false);
    expect(third.id).not.toEqual(first.id);
  });

  it('approve does not affect a DIFFERENT argv shape', async () => {
    const hook = svc.makeHook('kubectl', CWD, CALLER);
    const first = await hook({ tool: 'kubectl', argv: ['rollout', 'undo', 'deploy/x'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    await svc.approve(first.id, null);
    const other = await hook({ tool: 'kubectl', argv: ['rollout', 'undo', 'deploy/y'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    expect(other.approved).toBe(false);
    expect(other.id).not.toEqual(first.id);
  });

  it('approve does not affect a DIFFERENT tool', async () => {
    const hookK = svc.makeHook('kubectl', CWD, CALLER);
    const hookG = svc.makeHook('gh', CWD, CALLER);
    const first = await hookK({ tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    await svc.approve(first.id, null);
    const other = await hookG({ tool: 'gh', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    expect(other.approved).toBe(false);
  });

  it('reject leaves no approved row for later bypass', async () => {
    const hook = svc.makeHook('kubectl', CWD, CALLER);
    const first = await hook({ tool: 'kubectl', argv: ['x'], rule: 'approval_subcommands', matched: 'x' });
    expect(await svc.reject(first.id, 'admin')).toBe(true);
    const second = await hook({ tool: 'kubectl', argv: ['x'], rule: 'approval_subcommands', matched: 'x' });
    expect(second.approved).toBe(false);
    expect(second.id).not.toEqual(first.id);
  });

  it('expired pending row becomes a new request', async () => {
    const hook = svc.makeHook('kubectl', CWD, CALLER);
    const first = await hook({ tool: 'kubectl', argv: ['x'], rule: 'approval_subcommands', matched: 'x' });
    now += 700_000; // > 10 min TTL
    const second = await hook({ tool: 'kubectl', argv: ['x'], rule: 'approval_subcommands', matched: 'x' });
    expect(second.id).not.toEqual(first.id);
    expect((await svc.get(first.id))!.status).toBe('expired');
  });

  it('approving an expired row is rejected', async () => {
    const hook = svc.makeHook('kubectl', CWD, CALLER);
    const first = await hook({ tool: 'kubectl', argv: ['x'], rule: 'approval_subcommands', matched: 'x' });
    now += 700_000;
    expect(await svc.approve(first.id, null)).toBe(false);
  });
});

it('consent metrics include admin refusal and exactly one expiry per transition',async ()=>{
 const store=await SplicedockStore.open(':memory:');let now=Date.now();const events:string[]=[];
 const svc=new ApprovalService({store,strongTools:['repo_delete'],sweepIntervalMs:0,now:()=>now,onConsentEvent:(level,event)=>events.push(`${level}:${event}`)});
 const out=await svc.makeHook('repo_delete',CWD,CALLER)({tool:'repo_delete',argv:['delete','fixture'],rule:'approval_subcommands',matched:'delete'});
 expect(await svc.approve(out.id,'admin')).toBe(false);expect(events).toEqual(['strong:webauthn_required_refused']);
 now+=600001;await svc.sweep();await svc.sweep();expect(events).toEqual(['strong:webauthn_required_refused','strong:expired']);svc.stop();await store.close();
});

describe('ApprovalService onRequested', () => {
  it('fires once per new pending row with id, tool and expiry', async () => {
    const store = await SplicedockStore.open(':memory:');
    const now = 1_000_000;
    const seen: Array<{ id: string; tool: string; expires_at: number }> = [];
    const svc = new ApprovalService({ store, ttlMs: 600_000, sweepIntervalMs: 0, now: () => now, onRequested: (i) => seen.push(i) });
    const hook = svc.makeHook('kubectl', CWD, CALLER);
    const a = await hook({ tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    await hook({ tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths', matched: 'rollout undo' });
    expect(seen).toEqual([{ id: a.id, tool: 'kubectl', expires_at: a.expires_at }]);
    await store.close();
  });

  it('a throwing hook does not break the request', async () => {
    const store = await SplicedockStore.open(':memory:');
    const svc = new ApprovalService({ store, ttlMs: 600_000, sweepIntervalMs: 0, onRequested: () => { throw new Error('boom'); } });
    const out = await svc.makeHook('kubectl', CWD, CALLER)({ tool: 'kubectl', argv: ['x'], rule: 'approval_subcommands', matched: 'x' });
    expect(out.approved).toBe(false);
    expect(await svc.list({ status: 'pending' })).toHaveLength(1);
    await store.close();
  });
});
