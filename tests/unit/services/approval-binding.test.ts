import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService, argvHash } from '../../../src/services/approvals/base.js';
import { LEGACY_QUERY_TOKEN_ID, runWithCaller } from '../../../src/common/request/context.js';
import { logger } from '../../../src/common/logger.js';

const INPUT = { tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths' as const, matched: 'rollout undo' };
const A1 = { profile: 'profA', tokenId: 'tok-1', authenticated: true };
const A2 = { profile: 'profA', tokenId: 'tok-2', authenticated: true };
const B1 = { profile: 'profB', tokenId: 'tok-1', authenticated: true };
const CWD = '/srv/placeholder/workspace';

describe('ApprovalService — caller binding', () => {
  let store: SplicedockStore;
  let svc: ApprovalService;
  let now: number;
  let events: Array<[string, string]>;

  beforeEach(async () => {
    now = 1_000_000;
    events = [];
    store = await SplicedockStore.open(':memory:');
    svc = new ApprovalService({
      store,
      ttlMs: 600_000,
      sweepIntervalMs: 0,
      now: () => now,
      onEvent: (tool, event) => events.push([tool, event]),
    });
  });

  const call = async (caller: typeof A1 | undefined) => {
    const hook = svc.makeHook('kubectl', CWD);
    return caller ? await runWithCaller(caller, () => hook(INPUT)) : await hook(INPUT);
  };

  it('same profile + token creates, reserves, then consumes on finalize', async () => {
    const first = await call(A1);
    expect(first.approved).toBe(false);
    expect(await svc.approve(first.id, 'admin')).toBe(true);
    const second = await call(A1);
    expect(second.approved).toBe(true);
    expect((await svc.get(first.id))?.status).toBe('reserved');
    expect(await svc.finalize(first.id)).toBe(true);
    expect((await svc.get(first.id))?.status).toBe('consumed');
    expect((await svc.get(first.id))?.profile).toBe('profA');
  });

  it.each([
    ['other profile', B1],
    ['other token', A2],
  ])('%s does not consume, logs binding_refused, row stays approved', async (_n, other) => {
    const first = await call(A1);
    await svc.approve(first.id, 'admin');
    const warn = vi.spyOn(logger, 'warn');
    const res = await call(other);
    expect(res.approved).toBe(false);
    expect(res.id).not.toBe(first.id);
    expect((await svc.get(first.id))?.status).toBe('approved');
    const refused = warn.mock.calls.find(c => c[0] === 'approval binding_refused');
    expect(refused).toBeTruthy();
    const ctx = JSON.stringify(refused![1]);
    expect(ctx).toContain(first.id);
    expect(ctx).not.toContain('undo');
    expect(ctx).not.toContain('tok-');
    expect(events).toContainEqual(['kubectl', 'binding_refused']);
    // the owner can still consume it
    expect((await call(A1)).approved).toBe(true);
    warn.mockRestore();
  });

  it('double consume fails (second call is a fresh pending row)', async () => {
    const first = await call(A1);
    await svc.approve(first.id, null);
    expect((await call(A1)).approved).toBe(true);
    expect((await call(A1)).approved).toBe(false);
  });

  it('expired approval is not consumable', async () => {
    const first = await call(A1);
    await svc.approve(first.id, null);
    now += 600_001;
    expect((await call(A1)).approved).toBe(false);
  });

  it('missing identity fails closed and consumes nothing', async () => {
    const first = await call(A1);
    await svc.approve(first.id, null);
    const res = await call(undefined);
    expect(res).toEqual({ approved: false, refused: 'approval_requires_profile_token' });
    expect((await svc.get(first.id))?.status).toBe('approved');
    expect(await svc.list({ status: 'pending' })).toHaveLength(0);
    expect(events).toContainEqual(['kubectl', 'identity_refused']);
  });

  it('unauthenticated (legacy ?profile=) caller cannot request an approval', async () => {
    const LEGACY = { profile: 'profA', tokenId: LEGACY_QUERY_TOKEN_ID, authenticated: false };
    const res = await call(LEGACY);
    expect(res).toEqual({ approved: false, refused: 'approval_requires_profile_token' });
    expect(await svc.list({})).toHaveLength(0);
    expect(events).toEqual([['kubectl', 'identity_refused']]);
  });

  it('unauthenticated caller cannot consume an approval bound to the legacy identity', async () => {
    // A row created before the fix, bound to the shared legacy id.
    const LEGACY = { profile: 'profA', tokenId: LEGACY_QUERY_TOKEN_ID, authenticated: false };
    await store.insertApproval({
      id: 'legacy-row',
      tool: 'kubectl',
      argv_hash: argvHash('kubectl', CWD, INPUT.argv),
      argv_json: JSON.stringify(INPUT.argv),
      rule: INPUT.rule,
      matched: INPUT.matched,
      requested_at: now,
      expires_at: now + 600_000,
      profile: 'profA',
      token_id: LEGACY_QUERY_TOKEN_ID,
      cwd: CWD,
    });
    await svc.approve('legacy-row', null);
    const res = await call(LEGACY);
    expect(res.approved).toBe(false);
    expect('refused' in res && res.refused).toBe('approval_requires_profile_token');
    expect((await svc.get('legacy-row'))?.status).toBe('approved');
  });

  it('a token id alone does not authenticate (authenticated flag is required)', async () => {
    const res = await call({ profile: 'profA', tokenId: 'tok-1', authenticated: false });
    expect('refused' in res).toBe(true);
    expect(await svc.list({})).toHaveLength(0);
  });

  it('explicit caller argument works without async context', async () => {
    const hook = svc.makeHook('kubectl', CWD, A1);
    const first = await hook(INPUT);
    await svc.approve(first.id, null);
    expect((await hook(INPUT)).approved).toBe(true);
  });

  it('pending rows are per-caller (no cross-caller reuse)', async () => {
    const a = await call(A1);
    const b = await call(B1);
    expect(a.id).not.toBe(b.id);
  });

  it('emits approval events', async () => {
    const first = await call(A1);
    await svc.approve(first.id, 'x');
    await call(A1);
    await svc.finalize(first.id);
    const second = await call(A1);
    await svc.reject(second.id, 'x');
    const names = events.map(e => e[1]);
    expect(names).toEqual(['requested', 'approved', 'consumed', 'requested', 'rejected']);
  });

  it('sweep emits expired per tool', async () => {
    await call(A1);
    now += 600_001;
    await svc.sweep();
    expect(events).toContainEqual(['kubectl', 'expired']);
  });
});
