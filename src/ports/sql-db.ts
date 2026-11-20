// Dialect-neutral asynchronous SQL handle.
//
// Two backends implement it: SqliteDb (better-sqlite3, synchronous under the
// hood, serialised by an async mutex) and PgDb (a node-postgres pool). Every
// call returns a Promise, so the Postgres path never blocks the event loop.
//
// Transactions are ambient: inside a `transaction(fn)` callback, statements
// prepared on the same SqlDb run on that transaction's connection (tracked
// with AsyncLocalStorage), and a nested `transaction()` becomes a SAVEPOINT.

export type SqlParam = string | number | bigint | Buffer | null | undefined;
export type SqlNamedParams = Record<string, SqlParam>;

export interface SqlRunResult {
  changes: number;
}

export interface SqlStatement {
  run(...params: unknown[]): Promise<SqlRunResult>;
  get(...params: unknown[]): Promise<unknown>;
  all(...params: unknown[]): Promise<unknown[]>;
}

/**
 * `immediate` takes the SQLite write lock up front (BEGIN IMMEDIATE). On
 * Postgres all modes are plain BEGIN: serialisation there comes from row
 * locks (SELECT ... FOR UPDATE) and conditional updates, not from the mode.
 */
export interface SqlTransaction<A extends unknown[], T> {
  (...args: A): Promise<T>;
  immediate(...args: A): Promise<T>;
  deferred(...args: A): Promise<T>;
  exclusive(...args: A): Promise<T>;
}

export interface SqlDb {
  readonly dialect: 'postgres' | 'sqlite';
  prepare(sql: string): SqlStatement;
  /**
   * Run one or more statements with no result. `timeoutMs` overrides the
   * backend's client-side query timeout for this call (pass it alongside a
   * matching `SET LOCAL statement_timeout`); backends without one ignore it.
   */
  exec(sql: string, opts?: { timeoutMs?: number }): Promise<void>;
  transaction<A extends unknown[], T>(fn: (...args: A) => Promise<T> | T): SqlTransaction<A, T>;
  /**
   * Run `fn` only if this process wins a cross-replica mutex for `key`.
   * Postgres: session-level pg_try_advisory_lock on a dedicated connection,
   * always unlocked in finally; a loser skips (`ran: false`) instead of waiting.
   * SQLite: single process, so it just runs `fn`.
   */
  tryWithAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }>;
  close(): Promise<void>;
}

export function isPostgres(db: SqlDb): boolean {
  return db.dialect === 'postgres';
}

export function isPostgresDsn(target: string): boolean {
  return /^postgres(ql)?:\/\//i.test(target);
}

/**
 * Pick the storage target from env. A set-but-malformed SPLICEDOCK_DB_DSN is a
 * hard error (never silently treated as a SQLite path, which would also log
 * the value); the message deliberately does not echo it.
 */
export function resolveDbTarget(env: Record<string, string | undefined>): string {
  const dsn = env['SPLICEDOCK_DB_DSN'];
  if (dsn !== undefined) {
    // An explicitly empty DSN is a misconfiguration (e.g. a missing secret
    // key), not a request for SQLite: fail instead of silently diverging.
    if (dsn.trim() === '') throw new Error('SPLICEDOCK_DB_DSN is set but empty');
    if (!isPostgresDsn(dsn)) {
      throw new Error('SPLICEDOCK_DB_DSN must be a postgres:// or postgresql:// URL');
    }
    return dsn;
  }
  // Multi-replica deployments set this so a pod with a missing DSN fails
  // instead of quietly opening its own private SQLite file.
  if (env['SPLICEDOCK_REQUIRE_POSTGRES'] === '1') {
    throw new Error('SPLICEDOCK_REQUIRE_POSTGRES=1 but SPLICEDOCK_DB_DSN is not set');
  }
  return env['SPLICEDOCK_DB_PATH'] ?? '/var/splicedock/data/splicedock.db';
}
