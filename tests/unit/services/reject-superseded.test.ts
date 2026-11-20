import { describe, it, expect } from 'vitest';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';
import { ApprovalService } from '../../../src/application/approvals/approval-service.js';

const caller = { profile: 'test', tokenId: 'fixture', authenticated: true };
const context = 'Clean up completed batch jobs after investigating failed scheduled runs';

describe('rejecting an approval already superseded by a grant', () => {
  it('still revokes and blocks the grant that superseded it', async () => {
    const store = await SplicedockStore.open(':memory:');
    const svc = new ApprovalService({ store, grantsEnabled: true, sweepIntervalMs: 0 });
    const request = (name: string) =>
      svc.makeHook('kubectl', '/workspace', caller, false, context)({ tool: 'kubectl', argv: ['delete', 'job', name, '-n', 'batch'], rule: 'approval_subcommands', matched: 'delete' });
    const execute = async (name: string) => {
      const out = await request(name); await svc.approve(out.id!, 'operator');
      const approved = await request(name); await svc.finalize(approved.id!); await svc.executionResult(approved.id!, true);
    };
    const pending = await request('x');
    await execute('one'); await execute('two');
    expect(await svc.listGrants()).toHaveLength(1);
    // A request matching the grant supersedes the still-pending approval.
    expect((await request('x')).approved).toBe(true);
    expect((await svc.get(pending.id!))?.status).toBe('rejected');

    expect(await svc.reject(pending.id!, 'operator')).toBe(true);

    const db = store.consentDatabase();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM standing_grants WHERE revoked_at IS NULL').get()).toEqual({ n: 0 });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM grant_blocks').get() as { n: number }).n).toBeGreaterThan(0);
    // A second rejection is a no-op, not another revocation round.
    expect(await svc.reject(pending.id!, 'operator')).toBe(false);
    await store.close();
  });

  it('a null-actor rejection of a superseded approval is still one-shot', async () => {
    const store = await SplicedockStore.open(':memory:');
    const now = Date.now();
    await store.insertApproval({
      id: 's1', tool: 'kubectl', argv_hash: 'h', argv_json: '["get"]', rule: 'r', matched: null,
      requested_at: now, expires_at: now + 60_000, profile: 'p', token_id: 't', cwd: '/tmp',
    });
    await store.consentDatabase().prepare("UPDATE pending_approvals SET status='rejected', rejected_reason='superseded_by_grant' WHERE id='s1'").run();
    expect(await store.rejectApproval('s1', null, now)).toBe(true);
    expect(await store.rejectApproval('s1', null, now)).toBe(false);
    await store.close();
  });
});
