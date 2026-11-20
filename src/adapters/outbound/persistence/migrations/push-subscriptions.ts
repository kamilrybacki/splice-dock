import type { SqlDb } from '../../../../ports/sql-db.js';
export async function migratePushSubscriptions(db:SqlDb):Promise<void> {
  if (db.dialect === 'postgres') return; // schema comes from pg-schema.ts
  await db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)`);
}
