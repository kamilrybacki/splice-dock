// Postgres backend for the async SqlDb interface: a node-postgres pool.
//
// Nothing here blocks the event loop. Each statement outside a transaction
// runs on any pooled connection; a transaction checks out one client and
// every statement issued from inside its callback (tracked with
// AsyncLocalStorage) runs on that client. node-postgres correlates replies
// per connection, and a connection whose state is unknown after an error
// (timeout, cancelled statement, broken socket, failed ROLLBACK) is destroyed
// instead of being returned to the pool.
//
// Timeouts are enforced server-side (statement_timeout, lock_timeout,
// idle_in_transaction_session_timeout) with a slightly longer client-side
// query_timeout as a backstop.
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { translate } from './pg-translate.js';
import type { SqlDb, SqlRunResult, SqlStatement, SqlTransaction } from '../../../ports/sql-db.js';
import { logger } from '../../../common/logger.js';

export interface PgDbOptions {
  /** Pool size. Defaults to SPLICEDOCK_DB_POOL_MAX or 10. */
  max?: number;
  /** Server-side statement_timeout in ms. Defaults to 15000. */
  statementTimeoutMs?: number;
}

const DEFAULT_POOL_MAX = 10;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const CLIENT_TIMEOUT_GRACE_MS = 5_000;
const IDLE_IN_TX_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

export class PgError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'PgError';
  }
}

// int8 (COUNT, BIGINT epoch-ms) and numeric (SUM) come back as strings by
// default; the app compares them as numbers. Scoped to this pool, not global.
const INT8_OID = 20;
const NUMERIC_OID = 1700;
const TYPES = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === INT8_OID || oid === NUMERIC_OID) return (v: string) => Number(v);
    return pg.types.getTypeParser(oid, format as 'text');
  }) as typeof pg.types.getTypeParser,
};

interface TxCtx {
  client: pg.PoolClient;
  depth: number;
  done: boolean;
}

/** Errors after which a connection's protocol/session state is not trusted. */
function poisonsConnection(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return true; // client-side: timeout, socket
  return code === '57014' || code.startsWith('08') || code.startsWith('57P');
}

function toPgError(err: unknown): PgError {
  if (err instanceof PgError) return err;
  const e = err as { message?: string; code?: string };
  return new PgError(e?.message ?? String(err), typeof e?.code === 'string' ? e.code : undefined);
}

export function poolMaxFromEnv(env: Record<string, string | undefined>): number {
  const raw = env['SPLICEDOCK_DB_POOL_MAX'];
  if (raw === undefined || raw === '') return DEFAULT_POOL_MAX;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error('SPLICEDOCK_DB_POOL_MAX must be an integer between 1 and 100');
  }
  return n;
}

export class PgDb implements SqlDb {
  readonly dialect = 'postgres' as const;
  private readonly pool: pg.Pool;
  // Same connection options as the pool, for one-off dedicated clients.
  private readonly clientConfig: pg.ClientConfig;
  private readonly als = new AsyncLocalStorage<TxCtx>();
  private closed = false;

  constructor(dsn: string, opts: PgDbOptions = {}) {
    const statementTimeout = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    this.clientConfig = {
      connectionString: dsn,
      statement_timeout: statementTimeout,
      lock_timeout: statementTimeout,
      idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS,
      query_timeout: statementTimeout + CLIENT_TIMEOUT_GRACE_MS,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      types: TYPES,
    };
    this.pool = new pg.Pool({ ...this.clientConfig, max: opts.max ?? poolMaxFromEnv(process.env) });
    // An idle pooled client can error (server restart); without a listener
    // that would crash the process. The pool drops the client by itself.
    this.pool.on('error', (err) => {
      logger.warn('postgres idle client error', { error: err.message });
    });
  }

  private current(): TxCtx | undefined {
    const ctx = this.als.getStore();
    return ctx && !ctx.done ? ctx : undefined;
  }

  private async query(sql: string, args: unknown[], timeoutMs?: number): Promise<pg.QueryResult> {
    if (this.closed) throw new PgError('postgres pool is closed');
    const t = translate(sql, args);
    const q: string | pg.QueryConfig = timeoutMs !== undefined
      ? { text: t.text, ...(t.values.length > 0 ? { values: t.values } : {}), query_timeout: timeoutMs + CLIENT_TIMEOUT_GRACE_MS } as pg.QueryConfig
      : t.values.length > 0 ? { text: t.text, values: t.values } : t.text;
    const ctx = this.current();
    try {
      const res: pg.QueryResult | pg.QueryResult[] = ctx ? await ctx.client.query(q) : await this.pool.query(q);
      // A multi-statement simple query returns one result per statement.
      return Array.isArray(res) ? (res[res.length - 1] ?? { rows: [], rowCount: 0 } as unknown as pg.QueryResult) : res;
    } catch (err) {
      throw toPgError(err);
    }
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...a: unknown[]): Promise<SqlRunResult> => ({ changes: (await this.query(sql, a)).rowCount ?? 0 }),
      get: async (...a: unknown[]): Promise<unknown> => (await this.query(sql, a)).rows[0],
      all: async (...a: unknown[]): Promise<unknown[]> => (await this.query(sql, a)).rows,
    };
  }

  async exec(sql: string, opts: { timeoutMs?: number } = {}): Promise<void> {
    await this.query(sql, [], opts.timeoutMs);
  }

  transaction<A extends unknown[], T>(fn: (...args: A) => Promise<T> | T): SqlTransaction<A, T> {
    const run = async (...args: A): Promise<T> => {
      const ctx = this.current();
      if (ctx) return await this.savepoint(ctx, () => fn(...args));
      if (this.closed) throw new PgError('postgres pool is closed');
      const client = await this.pool.connect();
      const tx: TxCtx = { client, depth: 1, done: false };
      let destroy: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await this.als.run(tx, () => fn(...args));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        if (poisonsConnection(err)) destroy = err instanceof Error ? err : new Error(String(err));
        if (!destroy) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackErr) {
            destroy = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
          }
        }
        throw toPgError(err);
      } finally {
        tx.done = true;
        client.release(destroy);
      }
    };
    const t = run as SqlTransaction<A, T>;
    t.immediate = run;
    t.deferred = run;
    t.exclusive = run;
    return t;
  }

  private async savepoint<T>(ctx: TxCtx, body: () => Promise<T> | T): Promise<T> {
    const sp = `sp_${ctx.depth}`;
    ctx.depth++;
    try {
      await ctx.client.query(`SAVEPOINT ${sp}`);
      try {
        const result = await body();
        await ctx.client.query(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        await ctx.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        throw err;
      }
    } finally {
      ctx.depth--;
    }
  }

  /**
   * Run `fn` only if this process wins the session-level advisory lock `key`.
   *
   * The lock lives on a dedicated, non-pooled client. Holding a pooled client
   * here while `fn` itself needs the pool (pool.query / transaction()) would
   * deadlock at SPLICEDOCK_DB_POOL_MAX=1 and starve the pool when several
   * sweeps overlap. Ending the client releases the lock even if the explicit
   * unlock fails.
   */
  async tryWithAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.closed) throw new PgError('postgres pool is closed');
    const client = new pg.Client(this.clientConfig);
    // Attached for the client's whole lifetime: the client sits idle while fn
    // runs, and an 'error' (socket drop, server restart) with no listener
    // would crash the process.
    client.on('error', (err) => {
      logger.warn('postgres sweep-lock client error', { key, error: err.message });
    });
    try {
      try {
        await client.connect();
        const res = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
        if (res.rows[0]?.ok !== true) return { ran: false };
      } catch (err) {
        throw toPgError(err);
      }
      try {
        return { ran: true, value: await fn() };
      } finally {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [key]);
        } catch (unlockErr) {
          // Ending the session below releases the lock anyway.
          logger.warn('postgres advisory unlock failed; closing the session releases it', {
            key, error: unlockErr instanceof Error ? unlockErr.message : String(unlockErr),
          });
        }
      }
    } finally {
      try {
        await client.end();
      } catch (endErr) {
        logger.warn('postgres sweep-lock client end failed', {
          key, error: endErr instanceof Error ? endErr.message : String(endErr),
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
