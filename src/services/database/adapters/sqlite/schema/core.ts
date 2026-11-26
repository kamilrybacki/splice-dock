import type { SqlDb } from '../../../base.js';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS policy_overrides (
  tool_name   TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS profile_policy_overrides (
  tool_name   TEXT NOT NULL,
  profile     TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (tool_name, profile)
);

CREATE TABLE IF NOT EXISTS metrics_applied_seq (
  replica_id TEXT NOT NULL,
  tool_name  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (replica_id, tool_name)
);

CREATE TABLE IF NOT EXISTS metrics_snapshots (
  tool_name        TEXT PRIMARY KEY,
  total            INTEGER NOT NULL DEFAULT 0,
  allow            INTEGER NOT NULL DEFAULT 0,
  deny             INTEGER NOT NULL DEFAULT 0,
  rule_denies_json TEXT,
  buckets_60s_json TEXT,
  buckets_60s_anchor INTEGER,
  buckets_60s_from INTEGER,
  buckets_1h_json  TEXT,
  buckets_1h_anchor INTEGER,
  buckets_1h_from  INTEGER,
  last_ts          INTEGER,
  last_duration_ms INTEGER,
  updated_at       INTEGER NOT NULL
);

-- One-shot approval requests for policies with on_violation: approval.
--
-- Lifecycle: pending → approved/rejected/expired; the first matching call
-- after approval reserves the row ("reserved"), which becomes "consumed" once
-- the child process spawns, returns to "approved" only on a confirmed
-- pre-spawn failure, or expires if never settled. argv_hash binds the row to
-- one exact tool + cwd + argv (see approval-service.ts argvHash).
CREATE TABLE IF NOT EXISTS pending_approvals (
  id            TEXT PRIMARY KEY,
  tool          TEXT NOT NULL,
  argv_hash     TEXT NOT NULL,
  argv_json     TEXT NOT NULL,
  rule          TEXT NOT NULL,
  matched       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  requested_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  approved_at   INTEGER,
  approved_by   TEXT,
  consumed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS pending_approvals_lookup
  ON pending_approvals (tool, argv_hash, status);
CREATE INDEX IF NOT EXISTS pending_approvals_status
  ON pending_approvals (status, requested_at);

-- Runtime-added tools (http / cli only) created via the admin UI/API.
-- File-defined tools (splicedock.yaml) and discovered mcp_proxy/cli_passthrough
-- tools never live here. Loaded at startup and re-registered into the
-- in-memory ToolRegistry so UI-added tools survive a pod restart.
CREATE TABLE IF NOT EXISTS runtime_tools (
  id          TEXT PRIMARY KEY,
  driver      TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);

-- Runtime-added tool profiles (allow-glob sets) created via the admin UI/API.
-- File-defined profiles (splicedock.yaml) and reserved names never live here.
-- Loaded at startup and re-registered into the in-memory ProfileRegistry so
-- UI/API-added profiles survive a pod restart.
CREATE TABLE IF NOT EXISTS runtime_profiles (
  name          TEXT PRIMARY KEY,
  tools_json    TEXT NOT NULL,
  manifest_yaml TEXT,
  revision      INTEGER NOT NULL DEFAULT 1,
  origin        TEXT NOT NULL DEFAULT 'runtime',
  -- Set once when the row is first inserted and never rewritten: a profile deleted and
  -- recreated under the same name restarts at revision 1, so this is its identity.
  created_at    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT
);

-- Opaque bearer tokens that bind an MCP session to a single profile. Only the
-- sha256 hash of a token is stored; the raw token is shown once at creation.
-- When a request presents a valid token the ?profile= query is ignored.
CREATE TABLE IF NOT EXISTS profile_tokens (
  id           TEXT PRIMARY KEY,
  profile      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS profile_tokens_hash ON profile_tokens (token_hash);
`;


/** Idempotent: add the caller-binding columns to pending_approvals and the
 *  index covering the binding. Pre-existing rows keep NULL bindings and so
 *  can never satisfy the bound consume (NULL = ? is never true). */
export async function migrateApprovalBinding(db: SqlDb): Promise<void> {
  const cols = (await db.prepare('PRAGMA table_info(pending_approvals)').all() as Array<{ name: string }>).map(
    c => c.name,
  );
  if (!cols.includes('profile')) await db.exec('ALTER TABLE pending_approvals ADD COLUMN profile TEXT');
  if (!cols.includes('token_id')) await db.exec('ALTER TABLE pending_approvals ADD COLUMN token_id TEXT');
  // R4: working-directory binding. Pre-existing rows keep NULL and never match.
  if (!cols.includes('cwd')) await db.exec('ALTER TABLE pending_approvals ADD COLUMN cwd TEXT');
  // R6: two-phase consume (approved → reserved → consumed | approved).
  if (!cols.includes('reserved_at')) await db.exec('ALTER TABLE pending_approvals ADD COLUMN reserved_at INTEGER');
  await db.exec(
    `CREATE INDEX IF NOT EXISTS pending_approvals_binding
       ON pending_approvals (tool, argv_hash, profile, token_id, status)`,
  );
}

/** Idempotent: add the hourly-window anchor columns to metrics_snapshots.
 *  Pre-existing rows keep NULL and are treated as "history unknown". */
export async function migrateMetricsHourlyAnchor(db: SqlDb): Promise<void> {
  const cols = (await db.prepare('PRAGMA table_info(metrics_snapshots)').all() as Array<{ name: string }>).map(
    c => c.name,
  );
  if (!cols.includes('buckets_1h_anchor')) await db.exec('ALTER TABLE metrics_snapshots ADD COLUMN buckets_1h_anchor INTEGER');
  if (!cols.includes('buckets_1h_from')) await db.exec('ALTER TABLE metrics_snapshots ADD COLUMN buckets_1h_from INTEGER');
}

/** Idempotent: add the minute-window anchor columns to metrics_snapshots.
 *  Pre-existing rows keep NULL and are treated as "minute history unknown". */
export async function migrateMetricsMinuteAnchor(db: SqlDb): Promise<void> {
  const cols = (await db.prepare('PRAGMA table_info(metrics_snapshots)').all() as Array<{ name: string }>).map(
    c => c.name,
  );
  if (!cols.includes('buckets_60s_anchor')) await db.exec('ALTER TABLE metrics_snapshots ADD COLUMN buckets_60s_anchor INTEGER');
  if (!cols.includes('buckets_60s_from')) await db.exec('ALTER TABLE metrics_snapshots ADD COLUMN buckets_60s_from INTEGER');
}
