import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';

const OLD_TABLE = `
CREATE TABLE pending_approvals (
  id TEXT PRIMARY KEY, tool TEXT NOT NULL, argv_hash TEXT NOT NULL, argv_json TEXT NOT NULL,
  rule TEXT NOT NULL, matched TEXT, status TEXT NOT NULL DEFAULT 'pending',
  requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  approved_at INTEGER, approved_by TEXT, consumed_at INTEGER
);`;

describe('pending_approvals binding migration', () => {
  it('is idempotent and leaves legacy approved rows unconsumable', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'splicedock-mig-')), 'db.sqlite');
    const old = new Database(path);
    old.exec(OLD_TABLE);
    old
      .prepare(
        `INSERT INTO pending_approvals VALUES ('legacy','t','h','[]','r',NULL,'approved',1,9999999999999,2,'x',NULL)`,
      )
      .run();
    old.close();

    await (await SplicedockStore.open(path)).close();
    const store = await SplicedockStore.open(path); // second open: must not throw
    const cols = (new Database(path).prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('profile');
    expect(cols).toContain('token_id');

    expect(await store.reserveBoundApproval('t', 'h', 'p', 'tok', '', 5)).toBeNull();
    expect(await store.reserveBoundApproval('t', 'h', '', '', '', 5)).toBeNull();
    expect((await store.getApproval('legacy'))?.status).toBe('approved');
    await store.close();
  });
});
