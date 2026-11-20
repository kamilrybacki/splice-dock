import type Database from 'better-sqlite3';
import { SqliteDb } from '../../src/adapters/outbound/persistence/sqlite-db.js';

const wrappers = new WeakMap<Database.Database, SqliteDb>();

/** One async SqlDb wrapper per raw better-sqlite3 handle, so every consumer of a
 *  test database shares the same transaction mutex. */
export function sqliteDb(raw: Database.Database): SqliteDb {
  let db = wrappers.get(raw);
  if (!db) {
    db = new SqliteDb(raw);
    wrappers.set(raw, db);
  }
  return db;
}
