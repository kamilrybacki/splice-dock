// R4: an approval is bound to the resolved working directory as well as the
// tool, argv and caller. A different cwd never matches, and a row without a
// recorded cwd (created before this binding existed) is never consumed.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService, argvHash } from '../../../src/services/approvals/base.js';
import { renderApprovalDetail, renderApprovalsPage } from '../../../src/services/admin/adapters/fastify/web/pages/approvals.js';

const INPUT = { tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths' as const, matched: 'rollout undo' };
const CALLER = { profile: 'profA', tokenId: 'tok-1', authenticated: true };
const DIR_A = '/srv/placeholder/workspace-a';
const DIR_B = '/srv/placeholder/workspace-b';

describe('ApprovalService — cwd binding', () => {
  let store: SplicedockStore;
  let svc: ApprovalService;
  const now = 1_000_000;

  beforeEach(async () => {
    store = await SplicedockStore.open(':memory:');
    svc = new ApprovalService({ store, ttlMs: 600_000, sweepIntervalMs: 0, now: () => now });
  });

  it('records the cwd on the pending row', async () => {
    const first = await svc.makeHook('kubectl', DIR_A, CALLER)(INPUT);
    expect(first.approved).toBe(false);
    expect((await svc.get(first.id))?.cwd).toBe(DIR_A);
    expect((await svc.list({}))[0]?.cwd).toBe(DIR_A);
  });

  it('an approval for one cwd is not consumed from another cwd', async () => {
    const first = await svc.makeHook('kubectl', DIR_A, CALLER)(INPUT);
    expect(await svc.approve(first.id, 'admin')).toBe(true);

    const other = await svc.makeHook('kubectl', DIR_B, CALLER)(INPUT);
    expect(other.approved).toBe(false);
    expect(other.id).not.toBe(first.id);
    expect((await svc.get(first.id))?.status).toBe('approved');

    const same = await svc.makeHook('kubectl', DIR_A, CALLER)(INPUT);
    expect(same).toEqual({ approved: true, id: first.id });
  });

  it('pending rows are not reused across cwds', async () => {
    const a = await svc.makeHook('kubectl', DIR_A, CALLER)(INPUT);
    const b = await svc.makeHook('kubectl', DIR_B, CALLER)(INPUT);
    expect(a.id).not.toBe(b.id);
  });

  it('argvHash depends on the cwd', () => {
    expect(argvHash('kubectl', DIR_A, INPUT.argv)).not.toEqual(argvHash('kubectl', DIR_B, INPUT.argv));
    expect(argvHash('kubectl', DIR_A, INPUT.argv)).toEqual(argvHash('kubectl', DIR_A, INPUT.argv));
    // No ambiguity between the cwd and argv boundaries.
    expect(argvHash('t', '/a', ['b'])).not.toEqual(argvHash('t', '/a\0b', []));
  });
});

const PRE_CWD_TABLE = `
CREATE TABLE pending_approvals (
  id TEXT PRIMARY KEY, tool TEXT NOT NULL, argv_hash TEXT NOT NULL, argv_json TEXT NOT NULL,
  rule TEXT NOT NULL, matched TEXT, status TEXT NOT NULL DEFAULT 'pending',
  requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  approved_at INTEGER, approved_by TEXT, consumed_at INTEGER,
  profile TEXT, token_id TEXT
);`;

describe('pending_approvals cwd migration', () => {
  it('adds the cwd column and never consumes a legacy row without a cwd', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'splicedock-cwd-')), 'db.sqlite');
    const old = new Database(path);
    old.exec(PRE_CWD_TABLE);
    // A bound, approved row from before the cwd binding, whose hash even
    // equals what the new code computes for DIR_A: it must still not match.
    old
      .prepare(
        `INSERT INTO pending_approvals VALUES (?, 'kubectl', ?, ?, 'r', NULL, 'approved', 1, 9999999999999, 2, 'x', NULL, ?, ?)`,
      )
      .run('legacy', argvHash('kubectl', DIR_A, INPUT.argv), JSON.stringify(INPUT.argv), CALLER.profile, CALLER.tokenId);
    old.close();

    await (await SplicedockStore.open(path)).close();
    const store = await SplicedockStore.open(path); // idempotent
    const cols = (new Database(path).prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('cwd');

    const svc = new ApprovalService({ store, sweepIntervalMs: 0, now: () => 5 });
    const res = await svc.makeHook('kubectl', DIR_A, CALLER)(INPUT);
    expect(res.approved).toBe(false);
    expect((await store.getApproval('legacy'))?.status).toBe('approved');
    expect((await store.getApproval('legacy'))?.cwd).toBeNull();
    await store.close();
  });
});

describe('admin approvals view — cwd', () => {
  const HOSTILE = '/tmp/<script>alert(1)</script>';
  const row = {
    id: 'row-1', tool: 'kubectl', argv: ['rollout', 'undo'], rule: 'approval_subcommand_paths',
    matched: null, status: 'pending' as const, requested_at: 1, expires_at: 2, cwd: HOSTILE,
  };

  it('shows the cwd HTML-escaped in the pending list and the detail view', () => {
    for (const html of [
      renderApprovalsPage({ rows: [row], activeTab: 'pending' }),
      renderApprovalDetail({ row: { ...row, approved_at: null, approved_by: null, consumed_at: null } }),
    ]) {
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('/tmp/&lt;script&gt;alert(1)&lt;/script&gt;');
    }
  });

  it('marks a row without a cwd as legacy', () => {
    const html = renderApprovalDetail({ row: { ...row, cwd: null, approved_at: null, approved_by: null, consumed_at: null } });
    expect(html).toMatch(/cwd[^<]*<[^>]*>[^<]*legacy/i);
  });
});
