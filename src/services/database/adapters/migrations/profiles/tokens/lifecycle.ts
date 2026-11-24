import type { SqlDb } from '../../../../base.js';

/** Legacy rows deliberately retain NULL expiry until operator rotation. All times are milliseconds. */
export async function migrateProfileTokenLifecycle(db: SqlDb): Promise<void> {
  if (db.dialect === 'postgres') return; // schema comes from pg-schema.ts
  const columns = new Set((await db.prepare('PRAGMA table_info(profile_tokens)').all() as { name: string }[]).map(r => r.name));
  for (const [name, type] of Object.entries({ expires_at: 'INTEGER', revoked_at: 'INTEGER', revoked_reason: 'TEXT', revoked_by: 'TEXT', created_by: 'TEXT', rotated_from: 'TEXT' })) {
    if (!columns.has(name)) await db.exec(`ALTER TABLE profile_tokens ADD COLUMN ${name} ${type}`);
  }
  await db.exec('CREATE INDEX IF NOT EXISTS profile_tokens_lifecycle ON profile_tokens (revoked_at, expires_at)');
}
