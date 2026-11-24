import { describe, it, expect, afterAll } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { PgDb } from '../../../src/services/database/adapters/postgres/db.js';
import {
  TransportInvalidationBus,
  createPgTransport,
  type InvalidationMessage,
} from '../../../src/services/database/adapters/invalidation/bus.js';
import { TEST_PG_DSN, PG_SKIP_REASON, createIsolatedSchema, type IsolatedSchema } from '../../helpers/pg-test.js';

const quiet = { info: () => {}, warn: () => {} };
const schemas: IsolatedSchema[] = [];
afterAll(async () => { await Promise.all(schemas.map((s) => s.drop())); });

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function freshDsn(): Promise<string> {
  const s = await createIsolatedSchema(TEST_PG_DSN!);
  schemas.push(s);
  return s.dsn;
}

function makeReplica(dsn: string, store: SplicedockStore, replicaId: string) {
  const bus = new TransportInvalidationBus({
    transport: createPgTransport(dsn, (c, p) => store.notify(c, p)),
    replicaId,
    log: quiet,
  });
  const received: InvalidationMessage[] = [];
  bus.onMessage((m) => { received.push(m); });
  return { bus, received };
}

describe.skipIf(!TEST_PG_DSN)(TEST_PG_DSN ? 'invalidation bus (Postgres)' : `invalidation bus (Postgres) [skipped: ${PG_SKIP_REASON}]`, () => {
  it('delivers a publish from one replica to the other and not back to the sender', async () => {
    const dsn = await freshDsn();
    const store = await SplicedockStore.open(dsn);
    // NOTIFY is database-wide, so unique replica ids keep this test independent
    // of any other suite publishing on the same channel.
    const a = makeReplica(dsn, store, `A-${Date.now()}`);
    const b = makeReplica(dsn, store, `B-${Date.now()}`);
    try {
      await a.bus.start();
      await b.bus.start();

      await a.bus.publish('tools', 'ns__tool');
      await until(() => b.received.some((m) => m.kind === 'tools' && m.key === 'ns__tool'));
      const fromA = b.received.find((m) => m.key === 'ns__tool')!;
      expect(fromA.origin).toBe(a.bus.replicaId);

      // Round-trip the other way, then confirm A only ever saw B's message.
      await b.bus.publish('policy', 'gh__run');
      await until(() => a.received.some((m) => m.kind === 'policy'));
      expect(a.received.every((m) => m.origin !== a.bus.replicaId)).toBe(true);
      expect(b.received.every((m) => m.origin !== b.bus.replicaId)).toBe(true);
    } finally {
      await a.bus.stop();
      await b.bus.stop();
      await store.close();
    }
  });

  it('ignores hand-crafted junk on the channel', async () => {
    const dsn = await freshDsn();
    const store = await SplicedockStore.open(dsn);
    const a = makeReplica(dsn, store, `A-${Date.now()}`);
    try {
      await a.bus.start();
      await store.notify('splicedock_invalidate', 'not json');
      await store.notify('splicedock_invalidate', '{"kind":"evil","origin":"x"}');
      await store.notify('splicedock_invalidate', JSON.stringify({ kind: 'profiles', origin: 'outsider' }));
      await until(() => a.received.length >= 1);
      expect(a.received).toEqual([{ kind: 'profiles', origin: 'outsider' }]);
    } finally {
      await a.bus.stop();
      await store.close();
    }
  });

  it('reconnects after the listener backend is terminated and requests a resync', async () => {
    const dsn = await freshDsn();
    const store = await SplicedockStore.open(dsn);
    const bus = new TransportInvalidationBus({
      transport: createPgTransport(dsn, (c, p) => store.notify(c, p)),
      replicaId: `A-${Date.now()}`,
      backoffInitialMs: 20,
      backoffMaxMs: 100,
      log: quiet,
    });
    let resyncs = 0;
    bus.onResync(() => { resyncs += 1; });
    try {
      await bus.start();
      expect(resyncs).toBe(0);
      // Kill every session of this schema that is in LISTEN state.
      const killed = await killListeners(dsn);
      expect(killed).toBeGreaterThan(0);
      await until(() => resyncs >= 1);
    } finally {
      await bus.stop();
      await store.close();
    }
  });

  it('runtimeFingerprint changes when runtime tools / profiles change, including deletes', async () => {
    const dsn = await freshDsn();
    const store = await SplicedockStore.open(dsn);
    try {
      const empty = await store.runtimeFingerprint();
      await store.upsertRuntimeProfile('ops', ['grafana__*']);
      const withProfile = await store.runtimeFingerprint();
      expect(withProfile.profiles).not.toBe(empty.profiles);
      expect(withProfile.tools).toBe(empty.tools);

      await store.deleteRuntimeProfile('ops');
      expect((await store.runtimeFingerprint()).profiles).toBe(empty.profiles);
    } finally {
      await store.close();
    }
  });
});

async function killListeners(dsn: string): Promise<number> {
  const appName = new URL(dsn).searchParams.get('application_name');
  const admin = new PgDb(dsn);
  try {
    const rows = await admin.prepare(
      `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
        WHERE application_name = ? AND pid <> pg_backend_pid() AND query ILIKE 'LISTEN%'`,
    ).all(appName);
    return rows.length;
  } finally {
    await admin.close();
  }
}
