import type { SqlDb } from '../../base.js';

/** Optional operator-set agent label. Legacy rows keep NULL (logs fall back to the profile name). */
export async function migrateProfileTokenAgent(db: SqlDb): Promise<void> {
  if (db.dialect === 'postgres') return; // schema comes from pg-schema.ts
  const columns = new Set((await db.prepare('PRAGMA table_info(profile_tokens)').all() as { name: string }[]).map(r => r.name));
  if (!columns.has('agent')) await db.exec('ALTER TABLE profile_tokens ADD COLUMN agent TEXT');
}
