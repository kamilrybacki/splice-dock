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
