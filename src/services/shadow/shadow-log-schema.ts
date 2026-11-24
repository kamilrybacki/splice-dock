import type { SqlDb } from '../database/base.js';
export async function migrateShadowLog(db:SqlDb):Promise<void> {
  if (db.dialect === 'postgres') return; // schema comes from pg-schema.ts
 await db.exec(`CREATE TABLE IF NOT EXISTS s1_shadow_log(id INTEGER PRIMARY KEY,ts INTEGER NOT NULL,tool TEXT NOT NULL,profile TEXT NOT NULL,features TEXT NOT NULL,deterministic_decision TEXT NOT NULL,s1_label TEXT,s1_confidence REAL,s1_latency_ms INTEGER,outcome TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS s1_shadow_age ON s1_shadow_log(ts);`);
}
