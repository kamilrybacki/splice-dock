import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { CircuitBreaker } from '../../../src/services/policy/circuit-breaker.js';
import { StandingGrants } from '../../../src/services/approvals/standing-grants.js';
import { startPglite } from '../../helpers/pglite-server.js';

let srv: Awaited<ReturnType<typeof startPglite>>;
let store: SplicedockStore;

beforeAll(async () => {
  srv = await startPglite();
  store = await SplicedockStore.open(srv.dsn);
}, 60_000);
afterAll(async () => { await store?.close(); await srv?.stop(); });

describe('SplicedockStore on Postgres (PGlite, functional parity)', () => {
  it('migrates idempotently: reopening an already-migrated DB works', async () => {
    // pglite-socket serves one connection at a time, so close before reopening.
    await store.close();
    const again = await SplicedockStore.open(srv.dsn);
    await again.close();
    store = await SplicedockStore.open(srv.dsn);
  });

  it('approval lifecycle: insert -> approve -> reserve; second claim loses', async () => {
    const now = Date.now();
    await store.insertApproval({
      id: 'p1', tool: 'kubectl', argv_hash: 'h', argv_json: '["get"]', rule: 'r', matched: null,
      requested_at: now, expires_at: now + 60_000, profile: 'p', token_id: 't', cwd: '/tmp',
    });
    expect((await store.getApproval('p1'))!.status).toBe('pending');
    expect(await store.approveApproval('p1', 'me', now)).toBe(true);
    expect(await store.approveApproval('p1', 'me', now)).toBe(false);
    expect(await store.rejectApproval('p1', 'me', now)).toBe(false);
    expect(await store.reserveBoundApproval('kubectl', 'h', 'p', 't', '/tmp', now)).toBe('p1');
    expect(await store.reserveBoundApproval('kubectl', 'h', 'p', 't', '/tmp', now)).toBeNull();
    expect((await store.getApproval('p1'))!.status).toBe('reserved');
  });

  it('returns epoch-ms BIGINT columns as numbers', async () => {
    const row = (await store.getApproval('p1'))!;
    expect(typeof row.requested_at).toBe('number');
    expect(typeof row.expires_at).toBe('number');
  });

  it('seeds grant exceptions and markers, and counts come back as numbers', async () => {
    const db = store.consentDatabase();
    const n = await db.prepare('SELECT count(*) AS n FROM grant_exceptions').get() as { n: number };
    expect(typeof n.n).toBe('number');
    expect(n.n).toBeGreaterThan(0);
    const m = await db.prepare("SELECT count(*) AS n FROM breaker_migrations WHERE version = 'strong-recovery-v1'").get() as { n: number };
    expect(m.n).toBe(1);
  });

  it('breaker: bucket upsert (CASE ... DO UPDATE) and cleanup delete run on Postgres', async () => {
    const db = store.consentDatabase();
    const cfg = { enabled: true, mode: 'enforce' as const, window_seconds: 60, deny_threshold: 50, cooldown_seconds: 60,
      half_open_probes: 3, scopes: ['global', 'token'], read_allowlist: [] };
    const b = await CircuitBreaker.create(db, cfg as never);
    const caller = { profile: 'p', tokenId: 'bk', authenticated: true };
    const old = Date.now() - 600_000;
    await b.record(caller, true, old);
    const now = Date.now();
    for (let i = 0; i < 3; i++) await b.record(caller, true, now);
    const row = await db.prepare("SELECT n FROM breaker_buckets WHERE scope = 'global' AND second = ?").get(Math.floor(now / 1000)) as { n: number };
    expect(row.n).toBe(3);
    const stale = await db.prepare("SELECT count(*) AS n FROM breaker_buckets WHERE scope = 'global' AND second = ?").get(Math.floor(old / 1000)) as { n: number };
    expect(stale.n).toBe(0);
  });

  it('standing grants: exception upsert fires DO UPDATE on the second write', async () => {
    const db = store.consentDatabase();
    const g = new StandingGrants(db, true, 3, 0.5, () => Date.now());
    await g.setException('helm', 'uninstall', true, 'a');
    await g.setException('helm', 'uninstall', true, 'b');
    const rows = (await g.exceptions()).filter((e) => e.tool === 'helm');
    expect(rows).toHaveLength(1);
    await g.setException('helm', 'uninstall', false, 'a');
    expect((await g.exceptions()).filter((e) => e.tool === 'helm')).toHaveLength(0);
  });

  it('shadow log: summary aggregate queries run on Postgres', async () => {
    const { ShadowObserver } = await import('../../../src/services/shadow/base.js');
    const db = store.consentDatabase();
    const q = await ShadowObserver.create(db, { enabled: true, retention_days: 7, sample_rate: 1, queue_max: 10, timeout_ms: 100 } as never);
    await db.prepare("INSERT INTO s1_shadow_log(ts, tool, profile, features, deterministic_decision, s1_label, s1_confidence, s1_latency_ms, outcome) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(Date.now(), 'kubectl', 'p', '{}', 'allow', 'escalate', 0.9, 12, 'ok');
    const s = await q.summary();
    expect(s.p95_ms).toBe(12);
    expect(Number(s.outcomes[0].count)).toBe(1);
    expect(s.escalations_per_day).toHaveLength(1);
  });
});
