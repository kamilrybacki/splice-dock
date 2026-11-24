import type { SqlDb } from '../../../base.js';

/** Legacy rows keep manifest_yaml NULL until the startup catalog loader
 * backfills them from tools_json. PG receives the same columns in pg-schema. */
export async function migrateProfileCatalog(db: SqlDb): Promise<void> {
  await db.exec('CREATE TABLE IF NOT EXISTS deleted_config_profiles (name TEXT PRIMARY KEY)');
  if (db.dialect === 'postgres') return;
  const columns = new Set((await db.prepare('PRAGMA table_info(runtime_profiles)').all() as { name: string }[]).map(row => row.name));
  if (!columns.has('manifest_yaml')) await db.exec('ALTER TABLE runtime_profiles ADD COLUMN manifest_yaml TEXT');
  if (!columns.has('revision')) await db.exec('ALTER TABLE runtime_profiles ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  if (!columns.has('origin')) await db.exec("ALTER TABLE runtime_profiles ADD COLUMN origin TEXT NOT NULL DEFAULT 'runtime'");
}
