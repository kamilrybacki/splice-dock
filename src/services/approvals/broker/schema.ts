import type { SqlDb } from '../../database/base.js';
export async function migrateApprovalBroker(db: SqlDb): Promise<void> {
  if (db.dialect === 'postgres') return; // schema comes from pg-schema.ts
  const cols = new Set((await db.prepare('PRAGMA table_info(pending_approvals)').all() as {name:string}[]).map(c=>c.name));
  for (const [name,type] of Object.entries({kind:"TEXT NOT NULL DEFAULT 'passthrough'",exec_started_at:'INTEGER',exec_finished_at:'INTEGER',failure_reason:'TEXT'})) {
    if (!cols.has(name)) await db.exec(`ALTER TABLE pending_approvals ADD COLUMN ${name} ${type}`);
  }
}
