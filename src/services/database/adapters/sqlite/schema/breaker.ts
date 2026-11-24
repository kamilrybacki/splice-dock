import type { SqlDb } from '../../../base.js';
export async function migrateBreakerState(db:SqlDb):Promise<void> {
 await db.transaction(async ()=>{
 await db.exec(`CREATE TABLE IF NOT EXISTS breaker_state(scope TEXT PRIMARY KEY,family TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'closed',opened_at INTEGER NOT NULL DEFAULT 0,cooldown_until INTEGER NOT NULL DEFAULT 0,trip_count INTEGER NOT NULL DEFAULT 0,window_at INTEGER NOT NULL,denials INTEGER NOT NULL DEFAULT 0,probes INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS breaker_buckets(scope TEXT NOT NULL,second INTEGER NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(scope,second));
 CREATE INDEX IF NOT EXISTS breaker_buckets_age ON breaker_buckets(second);
 CREATE TABLE IF NOT EXISTS breaker_audit(id INTEGER PRIMARY KEY,ts INTEGER,scope TEXT,event TEXT,actor TEXT);
 CREATE TABLE IF NOT EXISTS breaker_probe_ids(scope TEXT NOT NULL,approval_id TEXT NOT NULL,PRIMARY KEY(scope,approval_id));`);
 // Reset untrusted pre-hardening counters even if the old ledger already
 // exists. DDL, reset and marker commit together, including across crashes.
 await db.exec('CREATE TABLE IF NOT EXISTS breaker_migrations(version TEXT PRIMARY KEY)');
 if(!await db.prepare('SELECT 1 FROM breaker_migrations WHERE version=?').get('strong-recovery-v1')){
 await db.prepare("UPDATE breaker_state SET probes=0,window_at=CASE WHEN state='half_open' THEN ? ELSE window_at END").run(Date.now());
 await db.exec('DELETE FROM breaker_probe_ids');
 await db.prepare('INSERT INTO breaker_migrations(version) VALUES(?)').run('strong-recovery-v1');
 }
 }).immediate();
}
