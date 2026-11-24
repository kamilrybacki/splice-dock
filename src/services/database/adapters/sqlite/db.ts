// SQLite backend for the async SqlDb interface.
//
// better-sqlite3 is synchronous and owns a single connection, so the only
// thing to protect is transaction isolation on that connection: while one
// async flow holds a transaction open, statements from other flows must wait
// (otherwise they would silently join the open transaction). An async mutex
// does that; statements issued from inside the transaction (tracked with
// AsyncLocalStorage) bypass it. Outside a transaction a statement runs
// immediately, exactly as before.
import { AsyncLocalStorage } from 'node:async_hooks';
import Database from 'better-sqlite3';
import { migrateSqlite } from './schema/index.js';
import type { SqlDb, SqlRunResult, SqlStatement, SqlTransaction } from '../../base.js';

interface TxCtx {
  depth: number;
  done: boolean;
}

type Mode = 'deferred' | 'immediate' | 'exclusive';
const BEGIN: Record<Mode, string> = {
  deferred: 'BEGIN',
  immediate: 'BEGIN IMMEDIATE',
  exclusive: 'BEGIN EXCLUSIVE',
};

export class SqliteDb implements SqlDb {
  readonly dialect = 'sqlite' as const;
  private readonly als = new AsyncLocalStorage<TxCtx>();
  private tail: Promise<void> = Promise.resolve();
  private locked = false;
  private schemaReady: Promise<void> | undefined;

  constructor(readonly raw: Database.Database) {}

  static open(path: string): SqliteDb {
    return new SqliteDb(new Database(path));
  }

  async tryWithAdvisoryLock<T>(_key: number, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    return { ran: true, value: await fn() };
  }

  /** BEGIN IMMEDIATE already serialises writers, so no row lock is needed. */
  rowLock(_mode: 'update' | 'skip_locked'): string {
    return '';
  }

  /** Single process: the transaction's write lock is the mutex. */
  async lockInTransaction(_key: string): Promise<void> {}

  ensureSchema(): Promise<void> {
    const run = (this.schemaReady ??= migrateSqlite(this));
    run.catch(() => { if (this.schemaReady === run) this.schemaReady = undefined; });
    return run;
  }

  private current(): TxCtx | undefined {
    const ctx = this.als.getStore();
    return ctx && !ctx.done ? ctx : undefined;
  }

  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    this.locked = true;
    return () => {
      this.locked = false;
      release();
    };
  }

  private async exclusive<T>(op: () => T): Promise<T> {
    if (!this.locked || this.current()) return op();
    const release = await this.acquire();
    try {
      return op();
    } finally {
      release();
    }
  }

  prepare(sql: string): SqlStatement {
    let stmt: Database.Statement | undefined;
    const compiled = (): Database.Statement => (stmt ??= this.raw.prepare(sql));
    return {
      run: async (...a: unknown[]): Promise<SqlRunResult> =>
        await this.exclusive(() => ({ changes: compiled().run(...a).changes })),
      get: async (...a: unknown[]): Promise<unknown> => await this.exclusive(() => compiled().get(...a)),
      all: async (...a: unknown[]): Promise<unknown[]> => await this.exclusive(() => compiled().all(...a)),
    };
  }

  async exec(sql: string): Promise<void> {
    return await this.exclusive(() => { this.raw.exec(sql); });
  }

  transaction<A extends unknown[], T>(fn: (...args: A) => Promise<T> | T): SqlTransaction<A, T> {
    const make = (mode: Mode) => async (...args: A): Promise<T> => {
      const ctx = this.current();
      if (ctx) return await this.savepoint(ctx, () => fn(...args));
      const release = await this.acquire();
      const tx: TxCtx = { depth: 1, done: false };
      try {
        this.raw.exec(BEGIN[mode]);
        try {
          const result = await this.als.run(tx, () => fn(...args));
          this.raw.exec('COMMIT');
          return result;
        } catch (err) {
          if (this.raw.inTransaction) this.raw.exec('ROLLBACK');
          throw err;
        }
      } finally {
        tx.done = true;
        release();
      }
    };
    const t = make('deferred') as SqlTransaction<A, T>;
    t.deferred = make('deferred');
    t.immediate = make('immediate');
    t.exclusive = make('exclusive');
    return t;
  }

  private async savepoint<T>(ctx: TxCtx, body: () => Promise<T> | T): Promise<T> {
    const sp = `sp_${ctx.depth}`;
    ctx.depth++;
    this.raw.exec(`SAVEPOINT ${sp}`);
    try {
      const result = await body();
      this.raw.exec(`RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.raw.exec(`ROLLBACK TO ${sp}`);
      this.raw.exec(`RELEASE ${sp}`);
      throw err;
    } finally {
      ctx.depth--;
    }
  }

  async close(): Promise<void> {
    if (!this.raw.open) return;
    const release = await this.acquire();
    try {
      this.raw.close();
    } finally {
      release();
    }
  }
}
