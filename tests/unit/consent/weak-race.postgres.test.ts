import { describe, it, expect, afterEach } from 'vitest';
import { PgDb } from '../../../src/adapters/outbound/persistence/pg-db.js';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';
import { ConsentStore, hash } from '../../../src/application/approvals/consent-store.js';
import { WeakConsent } from '../../../src/adapters/inbound/consent/weak.js';
import { TEST_PG_DSN, PG_SKIP_REASON, createIsolatedSchema, holdRowLocks, untilLockWaiters, type IsolatedSchema } from '../../helpers/pg-test.js';

// Two SplicedockStore pools on one schema stand in for two Splicedock replicas.
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
  const consentA = await ConsentStore.open(storeA.consentDatabase());
  const consentB = await ConsentStore.open(storeB.consentDatabase());
  const now = Date.now();
  for (const id of ['a', 'b']) {
    await storeA.insertApproval({ id, tool: 'test', argv_hash: 'hash', argv_json: '[]', rule: 'approval_subcommands', matched: 'x', requested_at: now, expires_at: now + 600000, profile: 'p', token_id: 'T', cwd: '/tmp' });
  }
  await raw.prepare('INSERT INTO consent_credentials(token_id,secret_hash,created_at) VALUES(?,?,?)').run('T', hash('fixture-T'), now);
  return { a: new WeakConsent(consentA, true), b: new WeakConsent(consentB, true), raw, now };
}
async function approved(db: PgDb): Promise<string[]> {
  return (await db.prepare("SELECT id FROM pending_approvals WHERE status='approved' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
}

describe.skipIf(!TEST_PG_DSN)(TEST_PG_DSN ? 'weak consent races (Postgres)' : `weak consent races (Postgres) [skipped: ${PG_SKIP_REASON}]`, () => {
  it('one credential approves at most one of two interleaved approvals', async () => {
    const { a, b, raw, now } = await replicas();
    // Hold both approval rows so each replica is parked mid-transaction, after
    // it has looked at the credential, then let both run.
    const holder = holdRowLocks(raw, "SELECT 1 FROM pending_approvals WHERE id IN ('a','b') FOR UPDATE");
    await holder.held;
    const pa = a.approve('a', 'fixture-T', now);
    const pb = b.approve('b', 'fixture-T', now);
    await untilLockWaiters(raw, 2);
    await holder.release();
    const results = await Promise.all([pa, pb]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await approved(raw)).toHaveLength(1);
  });

  it('two unforced concurrent approvals with one credential approve exactly one', async () => {
    const { a, b, raw, now } = await replicas();
    const results = await Promise.all([a.approve('a', 'fixture-T', now), b.approve('b', 'fixture-T', now)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await approved(raw)).toHaveLength(1);
  });

  it('a wrong secret does not burn the credential', async () => {
    const { a, b, now } = await replicas();
    expect(await a.approve('a', 'wrong', now)).toBe(false);
    expect(await b.approve('b', 'fixture-T', now)).toBe(true);
  });
});
