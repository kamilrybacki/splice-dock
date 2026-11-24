import { describe, it, expect, vi, beforeEach } from 'vitest';

// A fake pg.Client: every `new pg.Client(cfg)` records itself in `clients`.
const h = vi.hoisted(() => {
  type Behaviour = { lock: boolean | 'throw'; unlockFails: boolean; connectFails: boolean; endFails: boolean };
  const state = {
    behaviour: { lock: true, unlockFails: false, connectFails: false, endFails: false } as Behaviour,
    clients: [] as FakeClient[],
  };
  class FakeClient {
    readonly calls: string[] = [];
    readonly listeners = new Map<string, ((err: Error) => void)[]>();
    readonly listenersAtQuery: number[] = [];
    listenersAtConnect = -1;
    connected = false;
    ended = false;
    constructor(readonly config: Record<string, unknown>) {
      state.clients.push(this);
    }
    on(event: string, cb: (err: Error) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
      return this;
    }
    async connect() {
      this.listenersAtConnect = this.listeners.get('error')?.length ?? 0;
      if (state.behaviour.connectFails) throw new Error('connect refused');
      this.connected = true;
    }
    async query(sql: string, params?: unknown[]) {
      this.listenersAtQuery.push(this.listeners.get('error')?.length ?? 0);
      this.calls.push(`${sql.split(' ')[1]}:${String(params?.[0])}`);
      if (sql.includes('pg_try_advisory_lock')) {
        if (state.behaviour.lock === 'throw') throw new Error('boom');
        return { rows: [{ ok: state.behaviour.lock }] };
      }
      if (state.behaviour.unlockFails) throw new Error('unlock failed');
      return { rows: [{}] };
    }
    async end() {
      this.ended = true;
      if (state.behaviour.endFails) throw new Error('end failed');
    }
  }
  return { state, FakeClient };
});

vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  return { ...actual, default: { ...actual.default, Client: h.FakeClient } };
});

import { PgDb } from '../../../src/services/database/adapters/postgres/db.js';
import { SqliteDb } from '../../../src/services/database/adapters/sqlite/db.js';
import { runSweepExclusive, SWEEP_LOCK_KEYS } from '../../../src/services/database/sweep/lock.js';

const DSN = 'postgres://u:p@127.0.0.1:1/x';

function fakePg(lock: boolean | 'throw', opts: { unlockFails?: boolean; connectFails?: boolean; endFails?: boolean } = {}) {
  h.state.behaviour = {
    lock,
    unlockFails: opts.unlockFails ?? false,
    connectFails: opts.connectFails ?? false,
    endFails: opts.endFails ?? false,
  };
  const db = new PgDb(DSN, { max: 1 });
  // The pool must never be used for the lock itself.
  const poolConnect = vi.fn(async () => { throw new Error('pool must not be used for the lock'); });
  (db as unknown as { pool: unknown }).pool = { connect: poolConnect, end: async () => undefined, on: () => undefined };
  const client = () => {
    expect(h.state.clients).toHaveLength(1);
    return h.state.clients[0]!;
  };
  return { db, poolConnect, client };
}

beforeEach(() => {
  h.state.clients.length = 0;
});

describe('sweep lock keys', () => {
  it('are unique and avoid the schema migration key', () => {
    const keys = Object.values(SWEEP_LOCK_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(727274);
  });
});

describe('PgDb.tryWithAdvisoryLock', () => {
  it('locks and unlocks on a dedicated client, not a pooled one', async () => {
    const { db, poolConnect, client } = fakePg(true);
    const fn = vi.fn(async () => 42);
    expect(await db.tryWithAdvisoryLock(7, fn)).toEqual({ ran: true, value: 42 });
    expect(poolConnect).not.toHaveBeenCalled();
    const c = client();
    expect(c.calls).toEqual(['pg_try_advisory_lock($1):7', 'pg_advisory_unlock($1):7']);
    expect(c.ended).toBe(true);
  });

  it('builds the client from the pool connection options', async () => {
    const { db, client } = fakePg(true);
    await db.tryWithAdvisoryLock(7, async () => 1);
    const cfg = client().config;
    expect(cfg.connectionString).toBe(DSN);
    expect(cfg).toMatchObject({ statement_timeout: 15_000, lock_timeout: 15_000, connectionTimeoutMillis: 10_000 });
    expect(cfg.types).toBeDefined();
    expect(cfg).not.toHaveProperty('max');
  });

  it('attaches an error listener before connecting and keeps it for the whole lifetime', async () => {
    const { db, client } = fakePg(true);
    let listenersDuringFn = -1;
    await db.tryWithAdvisoryLock(7, async () => {
      listenersDuringFn = client().listeners.get('error')?.length ?? 0;
      // A socket drop while the client idles must be absorbed, not thrown.
      expect(() => client().listeners.get('error')!.forEach(cb => cb(new Error('socket hang up')))).not.toThrow();
    });
    const c = client();
    expect(c.listenersAtConnect).toBe(1);
    expect(listenersDuringFn).toBe(1);
    expect(c.listenersAtQuery).toEqual([1, 1]);
    expect(c.listeners.get('error')).toHaveLength(1);
  });

  it('runs fn while the pool has a single slot (no hold-and-wait)', async () => {
    const { db } = fakePg(true);
    // fn uses the pool (as the sweeps do); the lock client does not occupy it.
    const poolQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    (db as unknown as { pool: { query: unknown } }).pool.query = poolQuery;
    expect(await db.tryWithAdvisoryLock(7, async () => {
      await db.prepare('SELECT 1').all();
      return 'ok';
    })).toEqual({ ran: true, value: 'ok' });
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('skips and ends the client when another replica holds the lock', async () => {
    const { db, client } = fakePg(false);
    const fn = vi.fn(async () => 1);
    expect(await db.tryWithAdvisoryLock(7, fn)).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    expect(client().calls).toEqual(['pg_try_advisory_lock($1):7']);
    expect(client().ended).toBe(true);
  });

  it('unlocks and ends the client when fn throws, rethrowing the original error', async () => {
    const { db, client } = fakePg(true);
    const boom = new TypeError('sweep failed');
    await expect(db.tryWithAdvisoryLock(7, async () => { throw boom; })).rejects.toBe(boom);
    expect(client().calls).toEqual(['pg_try_advisory_lock($1):7', 'pg_advisory_unlock($1):7']);
    expect(client().ended).toBe(true);
  });

  it('still returns the result and ends the client when unlock fails', async () => {
    const { db, client } = fakePg(true, { unlockFails: true });
    expect(await db.tryWithAdvisoryLock(7, async () => 1)).toEqual({ ran: true, value: 1 });
    expect(client().ended).toBe(true);
  });

  it('ends the client when acquiring errors', async () => {
    const { db, client } = fakePg('throw');
    const fn = vi.fn(async () => 1);
    await expect(db.tryWithAdvisoryLock(7, fn)).rejects.toThrow('boom');
    expect(fn).not.toHaveBeenCalled();
    expect(client().ended).toBe(true);
  });

  it('ends the client when connecting fails', async () => {
    const { db, client } = fakePg(true, { connectFails: true });
    await expect(db.tryWithAdvisoryLock(7, async () => 1)).rejects.toThrow('connect refused');
    expect(client().calls).toEqual([]);
    expect(client().ended).toBe(true);
  });

  it('does not let a failing end() mask the result', async () => {
    const { db } = fakePg(true, { endFails: true });
    expect(await db.tryWithAdvisoryLock(7, async () => 'v')).toEqual({ ran: true, value: 'v' });
  });

  it('refuses after close without opening a client', async () => {
    const { db } = fakePg(true);
    await db.close();
    await expect(db.tryWithAdvisoryLock(7, async () => 1)).rejects.toThrow('closed');
    expect(h.state.clients).toHaveLength(0);
  });
});

describe('runSweepExclusive', () => {
  it('runs on SQLite (no-op lock)', async () => {
    const db = SqliteDb.open(':memory:');
    expect(await runSweepExclusive(db, 'tokenInactivity', async () => 'done')).toBe('done');
  });

  it('returns undefined and skips fn when the lock is held elsewhere', async () => {
    const { db } = fakePg(false);
    const fn = vi.fn(async () => 'done');
    expect(await runSweepExclusive(db, 'tokenInactivity', fn)).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes the per-sweep key to Postgres', async () => {
    const { db, client } = fakePg(true);
    await runSweepExclusive(db, 'approvalExpiry', async () => 1);
    expect(client().calls[0]).toBe(`pg_try_advisory_lock($1):${SWEEP_LOCK_KEYS.approvalExpiry}`);
  });
});
