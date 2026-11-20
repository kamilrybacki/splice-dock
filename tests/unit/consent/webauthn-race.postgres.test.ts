import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync, createHash, sign, type KeyObject } from 'node:crypto';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { PgDb } from '../../../src/adapters/outbound/persistence/pg-db.js';
import { SplicedockStore } from '../../../src/adapters/outbound/persistence/store.js';
import { ConsentStore } from '../../../src/application/approvals/consent-store.js';
import { WebAuthnConsent } from '../../../src/adapters/inbound/consent/webauthn.js';
import { TEST_PG_DSN, PG_SKIP_REASON, createIsolatedSchema, holdRowLocks, untilLockWaiters, type IsolatedSchema } from '../../helpers/pg-test.js';

// Two SplicedockStore pools on one schema stand in for two Splicedock replicas.
const open: Array<{ close(): Promise<void> }> = [];
const schemas: IsolatedSchema[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
  for (const s of schemas.splice(0)) await s.drop();
});

const CONFIG = { enabled: true, rp_id: 'example.com', origin: 'https://example.com', max_attempts: 3, rate_limit_per_minute: 10, hardware_roots: ['test-policy-only'] };
const CRED = Buffer.from('fixture-credential').toString('base64url');

function assertion(key: KeyObject, challenge: string, counter: number): AuthenticationResponseJSON {
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: CONFIG.origin }));
  const count = Buffer.alloc(4); count.writeUInt32BE(counter);
  const auth = Buffer.concat([createHash('sha256').update(CONFIG.rp_id).digest(), Buffer.from([5]), count]);
  const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), key);
  return { id: CRED, rawId: CRED, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'), signature: signature.toString('base64url') } };
}

async function replicas() {
  const s = await createIsolatedSchema(TEST_PG_DSN!); schemas.push(s);
  const storeA = await SplicedockStore.open(s.dsn); const storeB = await SplicedockStore.open(s.dsn);
  const raw = new PgDb(s.dsn);
  open.push(storeA, storeB, raw);
  const consentA = await ConsentStore.open(storeA.consentDatabase());
  const consentB = await ConsentStore.open(storeB.consentDatabase());
  const now = Date.now();
  const links: Record<string, string> = {};
  for (const id of ['a', 'b']) {
    await storeA.insertApproval({ id, tool: 'repo_delete', argv_hash: 'x', argv_json: JSON.stringify(['repo', id]), rule: 'approval_subcommands', matched: 'delete', requested_at: now, expires_at: now + 600000, profile: 'p', token_id: 'T', cwd: '/tmp' });
    links[id] = await consentA.bind(id);
  }
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const jwk = keys.publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  await raw.prepare('INSERT INTO webauthn_credentials(id,public_key,sign_count,label,created_at,trust_policy) VALUES(?,?,1,?,?,?)')
    .run(CRED, cose, 'test', now, createHash('sha256').update(JSON.stringify(CONFIG.hardware_roots)).digest('hex'));
  const events: string[] = [];
  const a = new WebAuthnConsent(consentA, CONFIG, (e) => events.push(e)); const b = new WebAuthnConsent(consentB, CONFIG, (e) => events.push(e));
  // Each replica verifies the approval it was handed, with its own challenge.
  const prepared = async (c: WebAuthnConsent, id: string, counter: number) => {
    const o = await c.options(links[id]!);
    return () => c.verify(links[id]!, o.id, assertion(keys.privateKey, o.challenge, counter));
  };
  return { a, b, raw, prepared, events };
}
async function approved(db: PgDb): Promise<string[]> {
  return (await db.prepare("SELECT id FROM pending_approvals WHERE status='approved' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
}
const credential = async (db: PgDb) => await db.prepare('SELECT sign_count,revoked_at FROM webauthn_credentials WHERE id=?').get(CRED) as { sign_count: number; revoked_at: number | null };

describe.skipIf(!TEST_PG_DSN)(TEST_PG_DSN ? 'WebAuthn counter races (Postgres)' : `WebAuthn counter races (Postgres) [skipped: ${PG_SKIP_REASON}]`, () => {
  it('one signature counter approves at most one of two interleaved approvals', async () => {
    const { a, b, raw, prepared } = await replicas();
    const va = await prepared(a, 'a', 2); const vb = await prepared(b, 'b', 2);
    // Hold the credential row so both replicas park mid-transaction, after
    // they have read sign_count=1, then let both run.
    const holder = holdRowLocks(raw, `SELECT 1 FROM webauthn_credentials WHERE id='${CRED}' FOR UPDATE`);
    await holder.held;
    const pa = va(); const pb = vb();
    await untilLockWaiters(raw, 2);
    await holder.release();
    const results = await Promise.all([pa, pb]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await approved(raw)).toHaveLength(1);
    expect((await credential(raw)).sign_count).toBe(2);
    expect((await credential(raw)).revoked_at).toBeNull();
  });

  it('reports the race loser as counter_raced without calling it clone_suspected', async () => {
    const { a, b, raw, prepared, events } = await replicas();
    const va = await prepared(a, 'a', 2); const vb = await prepared(b, 'b', 2);
    const holder = holdRowLocks(raw, `SELECT 1 FROM webauthn_credentials WHERE id='${CRED}' FOR UPDATE`);
    await holder.held;
    const pa = va(); const pb = vb();
    await untilLockWaiters(raw, 2);
    await holder.release();
    await Promise.all([pa, pb]);
    expect(events.filter((e) => e === 'counter_raced')).toHaveLength(1);
    expect(events).not.toContain('clone_suspected');
  });

  it('an already stale signed counter still revokes the credential', async () => {
    const { a, b, raw, prepared } = await replicas();
    expect(await (await prepared(a, 'a', 3))()).toBe(true);
    expect(await (await prepared(b, 'b', 2))()).toBe(false);
    expect((await credential(raw)).revoked_at).not.toBeNull();
  });

  it('two unforced concurrent verifies with the same counter approve at most one', async () => {
    const { a, b, raw, prepared } = await replicas();
    const va = await prepared(a, 'a', 2); const vb = await prepared(b, 'b', 2);
    const results = await Promise.all([va(), vb()]);
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
    expect((await approved(raw)).length).toBeLessThanOrEqual(1);
  });

  it('a revocation that commits first refuses the in-flight approval', async () => {
    const { a, raw, prepared } = await replicas();
    const va = await prepared(a, 'a', 2);
    const holder = holdRowLocks(raw, `SELECT 1 FROM webauthn_credentials WHERE id='${CRED}' FOR UPDATE`);
    await holder.held;
    // The revocation queues on the credential row first, the approval second.
    const revoke = raw.prepare('UPDATE webauthn_credentials SET revoked_at=? WHERE id=?').run(Date.now(), CRED);
    await untilLockWaiters(raw, 1);
    const pa = va();
    await untilLockWaiters(raw, 2);
    await holder.release();
    await revoke;
    expect(await pa).toBe(false);
    expect(await approved(raw)).toHaveLength(0);
    expect((await raw.prepare("SELECT status FROM pending_approvals WHERE id='a'").get() as { status: string }).status).toBe('pending');
  });

  it('sequential approvals with increasing counters both succeed', async () => {
    const { a, b, raw, prepared } = await replicas();
    expect(await (await prepared(a, 'a', 2))()).toBe(true);
    expect(await (await prepared(b, 'b', 3))()).toBe(true);
    expect(await approved(raw)).toEqual(['a', 'b']);
    expect((await credential(raw)).sign_count).toBe(3);
  });
});
