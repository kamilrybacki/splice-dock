// Final-state Postgres schema. SQLite grows its schema through ALTER-based
// migrations (PRAGMA table_info); Postgres has no legacy installs, so it is
// created in one idempotent step. Keep in sync with SCHEMA in store.ts and
// the SQLite migrations in ./migrations. Epoch-millisecond columns are BIGINT.
import type { SqlDb } from '../../base.js';

const LOCK_KEY = 727274; // arbitrary, serialises concurrent replicas starting up
/** Generous ceiling for one DDL statement during startup migration. */
const MIGRATION_STATEMENT_TIMEOUT_MS = 120_000;
/** How long a booting replica waits for another replica's migration before giving up. */
const MIGRATION_LOCK_WAIT_MS = 10 * 60_000;
const MIGRATION_LOCK_POLL_MS = 250;

export const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS policy_overrides (
  tool_name TEXT PRIMARY KEY, policy_json TEXT NOT NULL, updated_at BIGINT NOT NULL, updated_by TEXT);
CREATE TABLE IF NOT EXISTS profile_policy_overrides (
  tool_name TEXT NOT NULL, profile TEXT NOT NULL, policy_json TEXT NOT NULL, updated_at BIGINT NOT NULL,
  updated_by TEXT, PRIMARY KEY (tool_name, profile));
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  tool_name TEXT PRIMARY KEY, total BIGINT NOT NULL DEFAULT 0, allow BIGINT NOT NULL DEFAULT 0,
  deny BIGINT NOT NULL DEFAULT 0, rule_denies_json TEXT, buckets_60s_json TEXT, buckets_1h_json TEXT,
  last_ts BIGINT, last_duration_ms BIGINT, updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY, tool TEXT NOT NULL, argv_hash TEXT NOT NULL, argv_json TEXT NOT NULL,
  rule TEXT NOT NULL, matched TEXT, status TEXT NOT NULL DEFAULT 'pending',
  requested_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, approved_at BIGINT, approved_by TEXT,
  consumed_at BIGINT, profile TEXT, token_id TEXT, cwd TEXT, reserved_at BIGINT,
  level TEXT NOT NULL DEFAULT 'weak', op_digest TEXT, link_token_hash TEXT, link_expires_at BIGINT,
  link_used_at BIGINT, consent_method TEXT, consent_attempts INTEGER NOT NULL DEFAULT 0, rejected_reason TEXT,
  kind TEXT NOT NULL DEFAULT 'passthrough', exec_started_at BIGINT, exec_finished_at BIGINT, failure_reason TEXT,
  shape_key TEXT, base_shape_key TEXT, grant_id TEXT, approval_context TEXT, execution_success INTEGER);
CREATE INDEX IF NOT EXISTS pending_approvals_lookup ON pending_approvals (tool, argv_hash, status);
CREATE INDEX IF NOT EXISTS pending_approvals_status ON pending_approvals (status, requested_at);
CREATE INDEX IF NOT EXISTS pending_approvals_binding ON pending_approvals (tool, argv_hash, profile, token_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS consent_link ON pending_approvals(link_token_hash);
CREATE INDEX IF NOT EXISTS consent_pending ON pending_approvals(status, expires_at);
CREATE INDEX IF NOT EXISTS pending_approvals_shape ON pending_approvals(shape_key, status, requested_at);
CREATE TABLE IF NOT EXISTS runtime_tools (
  id TEXT PRIMARY KEY, driver TEXT NOT NULL, config_json TEXT NOT NULL, created_at BIGINT NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS deleted_config_profiles (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS runtime_profiles (
  name TEXT PRIMARY KEY, tools_json TEXT NOT NULL, manifest_yaml TEXT,
  revision BIGINT NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'runtime',
  updated_at BIGINT NOT NULL, updated_by TEXT);
ALTER TABLE runtime_profiles ADD COLUMN IF NOT EXISTS manifest_yaml TEXT;
ALTER TABLE runtime_profiles ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE runtime_profiles ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'runtime';
CREATE TABLE IF NOT EXISTS profile_tokens (
  id TEXT PRIMARY KEY, profile TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at BIGINT NOT NULL,
  last_used_at BIGINT, expires_at BIGINT, revoked_at BIGINT, revoked_reason TEXT, revoked_by TEXT,
  created_by TEXT, rotated_from TEXT, agent TEXT);
ALTER TABLE profile_tokens ADD COLUMN IF NOT EXISTS agent TEXT;
CREATE INDEX IF NOT EXISTS profile_tokens_hash ON profile_tokens (token_hash);
CREATE INDEX IF NOT EXISTS profile_tokens_lifecycle ON profile_tokens (revoked_at, expires_at);
CREATE TABLE IF NOT EXISTS webauthn_credentials(id TEXT PRIMARY KEY, public_key BYTEA NOT NULL, sign_count BIGINT NOT NULL,
  label TEXT NOT NULL, created_at BIGINT NOT NULL, last_used_at BIGINT, revoked_at BIGINT, trust_policy TEXT);
CREATE TABLE IF NOT EXISTS consent_challenges(id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, challenge_hash TEXT NOT NULL,
  purpose TEXT NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT);
CREATE TABLE IF NOT EXISTS consent_credentials(token_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL, rotated_at BIGINT, revoked_at BIGINT);
CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS breaker_state(scope TEXT PRIMARY KEY, family TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'closed',
  opened_at BIGINT NOT NULL DEFAULT 0, cooldown_until BIGINT NOT NULL DEFAULT 0, trip_count INTEGER NOT NULL DEFAULT 0,
  window_at BIGINT NOT NULL, denials INTEGER NOT NULL DEFAULT 0, probes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS breaker_buckets(scope TEXT NOT NULL, second BIGINT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(scope, second));
CREATE INDEX IF NOT EXISTS breaker_buckets_age ON breaker_buckets(second);
CREATE TABLE IF NOT EXISTS breaker_audit(id BIGSERIAL PRIMARY KEY, ts BIGINT, scope TEXT, event TEXT, actor TEXT);
CREATE TABLE IF NOT EXISTS breaker_probe_ids(scope TEXT NOT NULL, approval_id TEXT NOT NULL, PRIMARY KEY(scope, approval_id));
CREATE TABLE IF NOT EXISTS breaker_migrations(version TEXT PRIMARY KEY);
INSERT INTO breaker_migrations(version) VALUES ('strong-recovery-v1') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS s1_shadow_log(id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, tool TEXT NOT NULL, profile TEXT NOT NULL,
  features TEXT NOT NULL, deterministic_decision TEXT NOT NULL, s1_label TEXT, s1_confidence DOUBLE PRECISION,
  s1_latency_ms BIGINT, outcome TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS s1_shadow_age ON s1_shadow_log(ts);
CREATE TABLE IF NOT EXISTS standing_grants (
  id TEXT PRIMARY KEY, profile TEXT NOT NULL, token_id TEXT NOT NULL, tool TEXT NOT NULL,
  verb_path TEXT NOT NULL, resource_kind TEXT NOT NULL, namespace TEXT NOT NULL,
  object_count_max INTEGER NOT NULL DEFAULT 5, flags_allowed TEXT NOT NULL,
  created_at BIGINT NOT NULL, created_by TEXT NOT NULL, source_approval TEXT,
  context_refs TEXT NOT NULL, expires_at BIGINT NOT NULL, revoked_at BIGINT, revoked_by TEXT,
  suspended_at BIGINT, use_count INTEGER NOT NULL DEFAULT 0, use_count_max INTEGER NOT NULL DEFAULT 200,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, last_used_at BIGINT);
CREATE INDEX IF NOT EXISTS standing_grants_lookup ON standing_grants(tool, verb_path, profile, token_id, expires_at);
CREATE TABLE IF NOT EXISTS grant_exceptions(tool TEXT NOT NULL, verb_path TEXT NOT NULL DEFAULT '*',
  added_at BIGINT NOT NULL, added_by TEXT NOT NULL, PRIMARY KEY(tool, verb_path));
CREATE TABLE IF NOT EXISTS grant_blocks(shape_key TEXT PRIMARY KEY, until BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS grant_settings(key TEXT PRIMARY KEY);
`;

/**
 * Create the schema idempotently, serialised across replicas.
 *
 * Everything runs in ONE transaction so it stays on one pooled connection:
 * the lock is transaction-scoped (released on COMMIT/ROLLBACK, never leaked to
 * a different connection), and the DDL is atomic. The lock is polled with
 * pg_try_advisory_xact_lock (each attempt returns at once) rather than a
 * blocking wait, so neither the pool's server-side lock/statement timeouts
 * nor its client-side query timeout cut a waiting replica's startup short.
 */
export async function migratePostgres(db: SqlDb): Promise<void> {
  await db.transaction(async () => {
    await db.exec(`SET LOCAL lock_timeout = 0; SET LOCAL statement_timeout = ${MIGRATION_STATEMENT_TIMEOUT_MS}`);
    await acquireMigrationLock(db);
    // The pool's client-side query timeout would otherwise cut the DDL short
    // long before the raised server-side statement_timeout.
    await db.exec(PG_SCHEMA, { timeoutMs: MIGRATION_STATEMENT_TIMEOUT_MS });
    if (!await db.prepare("SELECT 1 FROM grant_settings WHERE key='exceptions_seeded'").get()) {
      for (const verb of ['drain', 'cordon', 'uncordon']) {
        await db.prepare('INSERT OR IGNORE INTO grant_exceptions VALUES (?,?,?,?)').run('kubectl', verb, Date.now(), 'default');
      }
      await db.prepare("INSERT INTO grant_settings VALUES ('exceptions_seeded') ON CONFLICT DO NOTHING").run();
    }
  })();
}

async function acquireMigrationLock(db: SqlDb): Promise<void> {
  const deadline = Date.now() + MIGRATION_LOCK_WAIT_MS;
  for (;;) {
    const row = await db.prepare('SELECT pg_try_advisory_xact_lock(?) AS ok').get(LOCK_KEY) as { ok: boolean };
    if (row.ok) return;
    if (Date.now() >= deadline) {
      throw new Error(`schema migration lock not acquired within ${MIGRATION_LOCK_WAIT_MS} ms`);
    }
    await new Promise((r) => setTimeout(r, MIGRATION_LOCK_POLL_MS));
  }
}
