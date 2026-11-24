import type { SqlDb } from '../../../base.js';
export async function migrateApprovalConsent(db: SqlDb): Promise<void> {
  const cols = new Set((await db.prepare('PRAGMA table_info(pending_approvals)').all() as {name:string}[]).map(c=>c.name));
  for (const [name, type] of Object.entries({level:"TEXT NOT NULL DEFAULT 'weak'",op_digest:'TEXT',link_token_hash:'TEXT',link_expires_at:'INTEGER',link_used_at:'INTEGER',consent_method:'TEXT',consent_attempts:'INTEGER NOT NULL DEFAULT 0',rejected_reason:'TEXT'})) {
    if (!cols.has(name)) await db.exec(`ALTER TABLE pending_approvals ADD COLUMN ${name} ${type}`);
  }
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS consent_link ON pending_approvals(link_token_hash);
    CREATE INDEX IF NOT EXISTS consent_pending ON pending_approvals(status, expires_at);
    CREATE TABLE IF NOT EXISTS webauthn_credentials(id TEXT PRIMARY KEY, public_key BLOB NOT NULL, sign_count INTEGER NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS consent_challenges(id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, challenge_hash TEXT NOT NULL, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
    CREATE TABLE IF NOT EXISTS consent_credentials(token_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, created_at INTEGER NOT NULL, rotated_at INTEGER, revoked_at INTEGER);`);
  const credentialCols = await db.prepare('PRAGMA table_info(webauthn_credentials)').all() as {name:string}[];
  if(!credentialCols.some(c=>c.name==='trust_policy')) await db.exec('ALTER TABLE webauthn_credentials ADD COLUMN trust_policy TEXT');
}
