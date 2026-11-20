import type { SqlDb } from '../../../../ports/sql-db.js';
export async function migrateStandingGrants(db:SqlDb):Promise<void> {
  if (db.dialect === 'postgres') return; // schema comes from pg-schema.ts
  await db.transaction(async ()=>{
    const cols=new Set((await db.prepare('PRAGMA table_info(pending_approvals)').all() as {name:string}[]).map(c=>c.name));
    for(const name of ['shape_key','base_shape_key','grant_id','approval_context'])if(!cols.has(name))await db.exec(`ALTER TABLE pending_approvals ADD COLUMN ${name} TEXT`);
    if(!cols.has('execution_success'))await db.exec('ALTER TABLE pending_approvals ADD COLUMN execution_success INTEGER');
    await db.exec(`CREATE TABLE IF NOT EXISTS standing_grants (
      id TEXT PRIMARY KEY, profile TEXT NOT NULL, token_id TEXT NOT NULL, tool TEXT NOT NULL,
      verb_path TEXT NOT NULL, resource_kind TEXT NOT NULL, namespace TEXT NOT NULL,
      object_count_max INTEGER NOT NULL DEFAULT 5, flags_allowed TEXT NOT NULL,
      created_at INTEGER NOT NULL, created_by TEXT NOT NULL, source_approval TEXT,
      context_refs TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, revoked_by TEXT,
      suspended_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0, use_count_max INTEGER NOT NULL DEFAULT 200,
      consecutive_failures INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER);
      CREATE INDEX IF NOT EXISTS standing_grants_lookup ON standing_grants(tool,verb_path,profile,token_id,expires_at);
      CREATE INDEX IF NOT EXISTS pending_approvals_shape ON pending_approvals(shape_key,status,requested_at);
      CREATE TABLE IF NOT EXISTS grant_exceptions(tool TEXT NOT NULL,verb_path TEXT NOT NULL DEFAULT '*',added_at INTEGER NOT NULL,added_by TEXT NOT NULL,PRIMARY KEY(tool,verb_path));
      CREATE TABLE IF NOT EXISTS grant_blocks(shape_key TEXT PRIMARY KEY,until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grant_settings(key TEXT PRIMARY KEY);`);
    if(!await db.prepare("SELECT 1 FROM grant_settings WHERE key='exceptions_seeded'").get()){
      for(const verb of ['drain','cordon','uncordon'])await db.prepare('INSERT OR IGNORE INTO grant_exceptions VALUES (?,?,?,?)').run('kubectl',verb,Date.now(),'default');
      await db.prepare("INSERT INTO grant_settings VALUES ('exceptions_seeded')").run();
    }
  })();
}
