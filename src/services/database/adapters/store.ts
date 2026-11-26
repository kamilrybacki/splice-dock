import { createHash } from 'node:crypto';
import { ConsentStore } from '../../approvals/consent/store.js';
import { authEvent, tokenEvent } from '../../authentication/lifecycle/events.js';
// Splicedock persistent store (SQLite via better-sqlite3).
//
// What lives here:
//   - policy_overrides:   per-tool runtime overrides for cli_passthrough policies
//   - metrics_snapshots:  periodic snapshot of in-memory tool counters so the
//                         WebUI shows non-zero numbers after a restart.
//                         Live counters stay in src/services/tool-metrics.ts.
//
// What does NOT live here:
//   - audit log: Loki via stdout JSON logger handles retention. In-memory
//                ring (src/services/audit-buffer.ts) serves the live feed.
//   - mcp_proxy tool registry, profiles: unchanged, file-driven.
//
// All writes are synchronous (better-sqlite3 is sync). Wrap multi-statement
// changes in a transaction via `db.transaction(...)`.

import Database from 'better-sqlite3';
import {
  HOURS, emptyWindow, hourOf, mergeWindows, windowFromRow, type HourlyWindow,
} from '../../metrics/hourly.js';
import { PgDb } from './postgres/db.js';
import type {
  ApprovalRepository, ApprovalRow, ApprovalRowInsert, MetricsDelta, MetricsRepository, MetricsSnapshotRow,
  PolicyOverrideRepository, PolicyOverrideRow, ProfileTokenRepository, ProfileTokenRow, RuntimeFingerprint,
  RuntimeFingerprintSource, RuntimeProfileRepository, RuntimeProfileRow, RuntimeProfileWriteResult, RuntimeToolRepository,
  RuntimeToolRow,
} from '../../../contracts/outbound/repositories.js';
export type {
  ApprovalRow, ApprovalRowInsert, MetricsDelta, MetricsSnapshotRow, PolicyOverrideRow, ProfileTokenRow,
  RuntimeFingerprint, RuntimeProfileRow, RuntimeProfileWriteResult, RuntimeToolRow,
} from '../../../contracts/outbound/repositories.js';
import { SqliteDb } from './sqlite/db.js';
import { isPostgresDsn } from './target.js';
import type { SqlDb } from '../base.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CliToolPolicy, ToolConfig } from '../../../config/types.js';
import { logger } from '../../../common/logger.js';


interface RuntimeProfileDbRow {
  name: string;
  tools_json: string;
  manifest_yaml: string | null;
  revision: number | bigint;
  origin: string;
  created_at: number | bigint;
  updated_at: number | bigint;
  updated_by: string | null;
}

function runtimeProfileRow(row: RuntimeProfileDbRow): RuntimeProfileRow {
  const tools = JSON.parse(row.tools_json) as unknown;
  if (!Array.isArray(tools) || !tools.every((tool): tool is string => typeof tool === 'string')) {
    throw new Error('tools_json is not an array of strings');
  }
  return {
    name: row.name,
    tools,
    manifest_yaml: row.manifest_yaml,
    revision: Number(row.revision),
    origin: row.origin === 'file' ? 'file' : 'runtime',
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    updated_by: row.updated_by,
  };
}

export class SplicedockStore
  implements
    PolicyOverrideRepository,
    RuntimeToolRepository,
    RuntimeProfileRepository,
    ProfileTokenRepository,
    MetricsRepository,
    ApprovalRepository,
    RuntimeFingerprintSource
{
  private touchIntervalMs = 60000;
  configureTokenTouch(seconds: number): void { this.touchIntervalMs = seconds * 1000; }
  private constructor(private readonly db: SqlDb) {}

  /** Open or create the SQLite file at `path`. Parent directory is created
   *  if missing. WAL mode is enabled for concurrent reads while we batch
   *  metrics snapshots in the background. */
  static async open(path: string): Promise<SplicedockStore> {
    // A postgres:// target selects the Postgres backend; anything else is a
    // SQLite file path (the default), so existing deploys are unchanged.
    if (isPostgresDsn(path)) {
      const pg = new PgDb(path);
      await pg.ensureSchema();
      logger.info('db open', { backend: 'postgres' });
      return new SplicedockStore(pg);
    }
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const raw = new Database(path);
    raw.pragma('journal_mode = WAL');
    raw.pragma('synchronous = NORMAL');
    raw.pragma('foreign_keys = ON');
    // Wait for another connection's short write transactions instead of
    // failing with SQLITE_BUSY.
    raw.pragma('busy_timeout = 5000');
    const db = new SqliteDb(raw);
    await db.ensureSchema();
    logger.info('db open', { path });
    return new SplicedockStore(db);
  }

  consentDatabase(): SqlDb { return this.db; }

  async close(): Promise<void> {
    await this.db.close();
  }

  // ---------------------------------------------------------------------
  // policy_overrides
  // ---------------------------------------------------------------------

  async getPolicyOverride(tool: string): Promise<CliToolPolicy | null> {
    const row = await this.db
      .prepare('SELECT policy_json FROM policy_overrides WHERE tool_name = ?')
      .get(tool) as { policy_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.policy_json) as CliToolPolicy;
    } catch (err) {
      logger.error('policy_overrides: malformed JSON; ignoring', {
        tool,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async listPolicyOverrides(): Promise<PolicyOverrideRow[]> {
    const rows = await this.db
      .prepare(
        'SELECT tool_name, policy_json, updated_at, updated_by FROM policy_overrides ORDER BY tool_name',
      )
      .all() as Array<{
      tool_name: string;
      policy_json: string;
      updated_at: number;
      updated_by: string | null;
    }>;
    const out: PolicyOverrideRow[] = [];
    for (const r of rows) {
      try {
        out.push({
          tool_name: r.tool_name,
          policy: JSON.parse(r.policy_json),
          updated_at: r.updated_at,
          updated_by: r.updated_by,
        });
      } catch {
        // Skip malformed rows; logged in getPolicyOverride if read individually.
      }
    }
    return out;
  }

  async setPolicyOverride(tool: string, policy: CliToolPolicy, updatedBy: string | null = null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO policy_overrides (tool_name, policy_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tool_name) DO UPDATE SET
           policy_json = excluded.policy_json,
           updated_at  = excluded.updated_at,
           updated_by  = excluded.updated_by`,
      )
      .run(tool, JSON.stringify(policy), Date.now(), updatedBy);
  }

  // Per-profile overrides: replace the tool's policy for callers on one profile.
  async getProfilePolicyOverride(tool: string, profile: string): Promise<CliToolPolicy | null> {
    const row = await this.db
      .prepare('SELECT policy_json FROM profile_policy_overrides WHERE tool_name = ? AND profile = ?')
      .get(tool, profile) as { policy_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.policy_json) as CliToolPolicy;
    } catch (err) {
      logger.error('profile_policy_overrides: malformed JSON; ignoring', {
        tool, profile, error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Profiles that have an override for `tool`, sorted. */
  async listProfilePolicyOverrideProfiles(tool: string): Promise<string[]> {
    const rows = await this.db
      .prepare('SELECT profile FROM profile_policy_overrides WHERE tool_name = ? ORDER BY profile')
      .all(tool) as Array<{ profile: string }>;
    return rows.map(r => r.profile);
  }

  async setProfilePolicyOverride(tool: string, profile: string, policy: CliToolPolicy, updatedBy: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO profile_policy_overrides (tool_name, profile, policy_json, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tool_name, profile) DO UPDATE SET
           policy_json = excluded.policy_json,
           updated_at  = excluded.updated_at,
           updated_by  = excluded.updated_by`,
      )
      .run(tool, profile, JSON.stringify(policy), Date.now(), updatedBy);
  }

  async deleteProfilePolicyOverride(tool: string, profile: string): Promise<boolean> {
    const info = await this.db
      .prepare('DELETE FROM profile_policy_overrides WHERE tool_name = ? AND profile = ?')
      .run(tool, profile);
    return info.changes > 0;
  }

  async deletePolicyOverride(tool: string): Promise<boolean> {
    const info = await this.db
      .prepare('DELETE FROM policy_overrides WHERE tool_name = ?')
      .run(tool);
    return info.changes > 0;
  }

  // ---------------------------------------------------------------------
  // cross-replica invalidation support
  // ---------------------------------------------------------------------

  /** True when this store is backed by Postgres (i.e. may have sibling replicas). */
  get isPostgres(): boolean {
    return this.db instanceof PgDb;
  }

  /**
   * Publish a NOTIFY. No-op on SQLite. Outside a transaction a NOTIFY is
   * delivered as soon as its own implicit transaction commits, so callers
   * invoke this only after their write has resolved.
   */
  async notify(channel: string, payload: string): Promise<void> {
    if (!this.isPostgres) return;
    await this.db.prepare('SELECT pg_notify(?, ?)').get(channel, payload);
  }

  /**
   * Cheap change-detection digests over the state replicas cache in memory.
   * runtime_tools has no updated_at, so content (id + config) is hashed;
   * hashing also catches deletes, which a max(updated_at) would miss.
   */
  async runtimeFingerprint(): Promise<RuntimeFingerprint> {
    const [tools, profiles, policy] = await Promise.all([
      this.digest('SELECT id, config_json FROM runtime_tools ORDER BY id'),
      this.digest('SELECT name, manifest_yaml, revision, origin, created_at, updated_at FROM runtime_profiles ORDER BY name'),
      Promise.all([
        this.digest('SELECT tool_name, policy_json, updated_at FROM policy_overrides ORDER BY tool_name'),
        this.digest('SELECT tool_name, profile, policy_json, updated_at FROM profile_policy_overrides ORDER BY tool_name, profile'),
      ]).then(([a, b]) => createHash('sha256').update(a + b).digest('hex')),
    ]);
    return { tools, profiles, policy };
  }

  private async digest(sql: string): Promise<string> {
    const rows = await this.db.prepare(sql).all();
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }

  // ---------------------------------------------------------------------
  // runtime_tools
  // ---------------------------------------------------------------------

  /** All runtime-added tools, oldest first. Malformed rows are skipped (logged). */
  async listRuntimeTools(): Promise<RuntimeToolRow[]> {
    const rows = await this.db
      .prepare('SELECT id, driver, config_json, created_at, created_by FROM runtime_tools ORDER BY created_at')
      .all() as Array<{ id: string; driver: string; config_json: string; created_at: number; created_by: string | null }>;
    const out: RuntimeToolRow[] = [];
    for (const r of rows) {
      try {
        out.push({
          id: r.id,
          driver: r.driver as RuntimeToolRow['driver'],
          config: JSON.parse(r.config_json) as ToolConfig,
          created_at: r.created_at,
          created_by: r.created_by,
        });
      } catch (err) {
        logger.error('runtime_tools: malformed config JSON; skipping', {
          id: r.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  async upsertRuntimeTool(id: string, driver: 'http' | 'cli' | 'mcp_proxy', config: ToolConfig, createdBy: string | null = null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO runtime_tools (id, driver, config_json, created_at, created_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           driver      = excluded.driver,
           config_json = excluded.config_json,
           created_by  = excluded.created_by`,
      )
      .run(id, driver, JSON.stringify(config), Date.now(), createdBy);
  }

  async deleteRuntimeTool(id: string): Promise<boolean> {
    const info = await this.db.prepare('DELETE FROM runtime_tools WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // ---------------------------------------------------------------------
  // runtime_profiles
  // ---------------------------------------------------------------------

  /** All catalog profiles, name order. Malformed legacy JSON is skipped (logged). */
  async listRuntimeProfiles(): Promise<RuntimeProfileRow[]> {
    const rows = await this.db
      .prepare('SELECT name, tools_json, manifest_yaml, revision, origin, created_at, updated_at, updated_by FROM runtime_profiles ORDER BY name')
      .all() as RuntimeProfileDbRow[];
    const out: RuntimeProfileRow[] = [];
    for (const row of rows) {
      try { out.push(runtimeProfileRow(row)); }
      catch (err) {
        logger.error('runtime_profiles: malformed tools JSON; skipping', {
          name: row.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  async getRuntimeProfile(name: string): Promise<RuntimeProfileRow | null> {
    const row = await this.db
      .prepare('SELECT name, tools_json, manifest_yaml, revision, origin, created_at, updated_at, updated_by FROM runtime_profiles WHERE name = ?')
      .get(name) as RuntimeProfileDbRow | undefined;
    return row ? runtimeProfileRow(row) : null;
  }

  /** Optimistic write. `baseRevision` is 0 for create; an existing profile must
   * match its current revision exactly. `tools_json` mirrors the parsed config
   * for old readers, while `manifest_yaml` preserves comments and formatting. */
  async saveRuntimeProfile(
    name: string,
    profile: import('../../../config/types.js').ProfileConfig,
    manifest: string,
    updatedBy: string | null,
    baseRevision: number,
    origin: 'file' | 'runtime' = 'runtime',
  ): Promise<RuntimeProfileWriteResult> {
    return this.db.transaction(async (): Promise<RuntimeProfileWriteResult> => {
      const current = await this.getRuntimeProfile(name);
      if ((current?.revision ?? 0) !== baseRevision) return { status: 'conflict', current };
      const updatedAt = Date.now();
      const revision = baseRevision + 1;
      const saved = await this.db.prepare(
        `INSERT INTO runtime_profiles (name, tools_json, manifest_yaml, revision, origin, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           tools_json = excluded.tools_json,
           manifest_yaml = excluded.manifest_yaml,
           revision = excluded.revision,
           origin = excluded.origin,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by
         WHERE runtime_profiles.revision = ?`,
      ).run(name, JSON.stringify(profile.tools), manifest, revision, origin, updatedAt, updatedAt, updatedBy, baseRevision);
      if (!saved.changes) return { status: 'conflict', current: await this.getRuntimeProfile(name) };
      const row = await this.getRuntimeProfile(name);
      if (!row) throw new Error('saved profile disappeared');
      return { status: 'ok', row };
    }).immediate();
  }

  /** Backward-compatible JSON-path adapter. Manifest writes use base revisions. */
  async upsertRuntimeProfile(name: string, tools: string[], updatedBy: string | null = null): Promise<void> {
    const current = await this.getRuntimeProfile(name);
    const profile = { tools, enable_code_mode: false, credentials: {} };
    const { dumpProfileManifest } = await import('../../profiles/adapters/yaml.js');
    const result = await this.saveRuntimeProfile(name, profile, dumpProfileManifest(profile), updatedBy, current?.revision ?? 0);
    if (result.status !== 'ok') throw new Error(`Concurrent profile update for '${name}'`);
  }

  async isConfigProfileDeleted(name: string): Promise<boolean> {
    return !!await this.db.prepare('SELECT name FROM deleted_config_profiles WHERE name = ?').get(name);
  }

  async deleteRuntimeProfile(name: string): Promise<boolean> {
    return this.db.transaction(async () => {
      const info = await this.db.prepare('DELETE FROM runtime_profiles WHERE name = ?').run(name);
      if (info.changes) await this.db.prepare('INSERT INTO deleted_config_profiles (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
      return info.changes > 0;
    }).immediate();
  }

  // ---------------------------------------------------------------------
  // profile_tokens
  // ---------------------------------------------------------------------

  async insertProfileToken(id: string, profile: string, tokenHash: string, ttlSeconds = 2592000, createdBy = 'system', agent: string | null = null): Promise<void> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 2592000) throw new Error('Invalid token lifetime');
    await this.db
      .prepare(
        `INSERT INTO profile_tokens (id, profile, token_hash, created_at, last_used_at, expires_at, created_by, agent)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(id, profile, tokenHash, Date.now(), Date.now() + ttlSeconds * 1000, createdBy, agent);
    tokenEvent('created');
    logger.info('token lifecycle', { event: 'created', token_id: id, actor: createdBy });
  }

  /** Tokens (incl. revocation/expiry) are read from the DB on every request and
   *  never cached in-process, so they need no cross-replica invalidation.
   *  Resolve a token hash to its profile, stamping last_used_at. Returns null
   *  for an unknown hash. The raw token never reaches the store — only its
   *  sha256 hash is looked up. */
  async findProfileByToken(tokenHash: string, now: number): Promise<{ id: string; profile: string; agent: string | null } | null> {
    // Transaction prevents revocation racing the lookup/touch pair.
    return await this.db.transaction(async () => {
      const row = await this.db.prepare(`SELECT id, profile, agent FROM profile_tokens
        WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
        .get(tokenHash, now) as { id: string; profile: string; agent: string | null } | undefined;
      if (!row) {
        const failed = await this.db.prepare('SELECT revoked_at, revoked_reason, expires_at FROM profile_tokens WHERE token_hash = ?').get(tokenHash) as { revoked_at: number | null; revoked_reason: string | null; expires_at: number | null } | undefined;
        authEvent(!failed ? 'unknown' : failed.revoked_at !== null ? (failed.revoked_reason === 'inactive' ? 'inactive' : 'revoked') : 'expired');
        return null;
      }
      authEvent('ok');
      await this.db.prepare(`UPDATE profile_tokens SET last_used_at = ? WHERE id = ?
        AND (last_used_at IS NULL OR last_used_at <= ?)`)
        .run(now, row.id, now - this.touchIntervalMs);
      return { id: row.id, profile: row.profile, agent: row.agent };
    })();
  }

  async listProfileTokens(): Promise<ProfileTokenRow[]> {
    return await this.db.prepare(`SELECT id, profile, created_at, last_used_at, expires_at,
      revoked_at, revoked_reason, revoked_by, created_by, rotated_from, agent
      FROM profile_tokens ORDER BY created_at`).all() as ProfileTokenRow[];
  }

  async sweepInactiveTokens(now: number, mode: 'observe' | 'enforce', days = 30): Promise<{ revoked: number; wouldRevoke: number }> {
    const cutoff = now - days * 86400000;
    if (mode === 'observe') {
      const row = await this.db.prepare(`SELECT count(*) AS n FROM profile_tokens
        WHERE revoked_at IS NULL AND COALESCE(last_used_at, created_at) < ?`).get(cutoff) as { n: number };
      return { revoked: 0, wouldRevoke: row.n };
    }
    return await this.db.transaction(async () => {
      const rows = await this.db.prepare(`UPDATE profile_tokens SET revoked_at = ?, revoked_reason = 'inactive', revoked_by = 'system'
        WHERE revoked_at IS NULL AND COALESCE(last_used_at, created_at) < ? RETURNING id`).all(now, cutoff) as { id: string }[];
      for (const row of rows) logger.info('token lifecycle', { event: 'revoked_inactive', token_id: row.id, actor: 'system' });
      return { revoked: rows.length, wouldRevoke: 0 };
    })();
  }

  async rotateProfileToken(id: string, newId: string, tokenHash: string, ttlSeconds = 2592000, actor = 'system'): Promise<boolean> {
    return await this.db.transaction(async () => {
      const now = Date.now();
      const old = await this.db.prepare(`UPDATE profile_tokens SET revoked_at = ?, revoked_reason = 'rotated', revoked_by = ?
        WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) RETURNING profile, agent`).get(now, actor, id, now) as { profile: string; agent: string | null } | undefined;
      if (!old) return false;
      await this.insertProfileToken(newId, old.profile, tokenHash, ttlSeconds, actor, old.agent);
      await this.db.prepare('UPDATE profile_tokens SET rotated_from = ? WHERE id = ?').run(id, newId);
      tokenEvent('rotated');
      logger.info('token lifecycle', { event: 'rotated', token_id: id, successor_id: newId, actor });
      return true;
    })();
  }

  /** Set (or clear with null) the agent label of an active token without changing its secret. */
  async setProfileTokenAgent(id: string, agent: string | null, actor = 'system'): Promise<{ id: string; profile: string; agent: string | null } | null> {
    const now = Date.now();
    const row = await this.db.prepare(`UPDATE profile_tokens SET agent = ?
      WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) RETURNING id, profile, agent`).get(agent, id, now) as { id: string; profile: string; agent: string | null } | undefined;
    if (!row) return null;
    logger.info('token lifecycle', { event: 'relabelled', token_id: id, agent, actor });
    return row;
  }

  async deleteProfileToken(id: string, actor = 'system', reason = 'manual'): Promise<boolean> {
    const changed = (await this.db.prepare(`UPDATE profile_tokens SET revoked_at = ?, revoked_reason = ?, revoked_by = ?
      WHERE id = ? AND revoked_at IS NULL`).run(Date.now(), reason, actor, id)).changes > 0;
    if (changed) { tokenEvent('revoked_manual'); logger.info('token lifecycle', { event: 'revoked', token_id: id, actor, reason }); }
    return changed;
  }

  // ---------------------------------------------------------------------
  // metrics_snapshots
  // ---------------------------------------------------------------------

  async getMetricsSnapshot(tool: string): Promise<MetricsSnapshotRow | null> {
    const row = await this.db
      .prepare(
        `SELECT tool_name, total, allow, deny, rule_denies_json,
                buckets_60s_json, buckets_1h_json, buckets_1h_anchor, buckets_1h_from,
                last_ts, last_duration_ms, updated_at
         FROM metrics_snapshots WHERE tool_name = ?`,
      )
      .get(tool) as
      | {
          tool_name: string;
          total: number;
          allow: number;
          deny: number;
          rule_denies_json: string | null;
          buckets_60s_json: string | null;
          buckets_1h_json: string | null;
          buckets_1h_anchor: number | null;
          buckets_1h_from: number | null;
          last_ts: number | null;
          last_duration_ms: number | null;
          updated_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      tool_name: row.tool_name,
      total: row.total,
      allow: row.allow,
      deny: row.deny,
      rule_denies: row.rule_denies_json ? safeParseObj(row.rule_denies_json) : {},
      buckets_60s: row.buckets_60s_json ? safeParseArr(row.buckets_60s_json) : [],
      buckets_1h: row.buckets_1h_json ? safeParseArr(row.buckets_1h_json) : [],
      buckets_1h_anchor: row.buckets_1h_anchor ?? null,
      buckets_1h_from: row.buckets_1h_from ?? null,
      last_ts: row.last_ts,
      last_duration_ms: row.last_duration_ms,
      updated_at: row.updated_at,
    };
  }

  async listMetricsSnapshots(): Promise<MetricsSnapshotRow[]> {
    const tools = await this.db
      .prepare('SELECT tool_name FROM metrics_snapshots ORDER BY tool_name')
      .all() as Array<{ tool_name: string }>;
    const snapshots: MetricsSnapshotRow[] = [];
    for (const t of tools) {
      const snapshot = await this.getMetricsSnapshot(t.tool_name);
      if (snapshot !== null) snapshots.push(snapshot);
    }
    return snapshots;
  }

  // ---------------------------------------------------------------------
  // pending_approvals
  // ---------------------------------------------------------------------

  async insertApproval(row: ApprovalRowInsert): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pending_approvals (
            id, tool, argv_hash, argv_json, rule, matched,
            status, requested_at, expires_at, profile, token_id, cwd
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.tool, row.argv_hash, row.argv_json, row.rule, row.matched,
        row.requested_at, row.expires_at, row.profile, row.token_id, row.cwd,
      );
  }

  /** Find an existing pending row for tool+argv_hash so a retry reuses it
   *  instead of inserting a duplicate. */
  async findPendingFor(
    tool: string,
    argv_hash: string,
    profile: string,
    token_id: string,
    cwd: string,
    now: number,
    lock = false,
  ): Promise<{ id: string; expires_at: number } | null> {
    const row = await this.db
      .prepare(
        `SELECT id, expires_at FROM pending_approvals
          WHERE tool = ? AND argv_hash = ? AND profile = ? AND token_id = ?
            AND cwd IS NOT NULL AND cwd = ?
            AND status = 'pending' AND expires_at > ?
          ORDER BY requested_at DESC LIMIT 1${lock ? this.db.rowLock('update') : ''}`,
      )
      .get(tool, argv_hash, profile, token_id, cwd, now) as { id: string; expires_at: number } | undefined;
    return row ?? null;
  }

  /** Atomically RESERVE one approved row bound to exactly this caller and
   *  cwd (status approved → reserved). A single conditional UPDATE: status,
   *  expiry, tool, argv_hash, profile, token_id and cwd must all match, and a
   *  row is only returned when exactly one row changed. Legacy rows (NULL
   *  binding or NULL cwd) never match. A reserved row is no longer approved,
   *  so it cannot be reserved twice; finalizeApproval / releaseApproval settle
   *  it, and expireStaleReservations expires one that is never settled. */
  async reserveBoundApproval(
    tool: string,
    argv_hash: string,
    profile: string,
    token_id: string,
    cwd: string,
    now: number,
    allowStrong = true,
    requireStrong = false,
  ): Promise<string | null> {
    const cond = `${requireStrong ? "level = 'strong' AND" : ''} kind = 'passthrough' AND tool = ? AND argv_hash = ? AND profile = ? AND token_id = ?
                  AND cwd IS NOT NULL AND cwd = ?
                  AND (level != 'strong' OR (${allowStrong ? '1' : '0'} = 1 AND consent_method = 'webauthn'))
                  AND status = 'approved' AND consumed_at IS NULL AND expires_at > ?`;
    // Recompute the strong binding before reservation. This synchronous section
    // has no await; the conditional UPDATE remains the reservation authority.
    const consent = new ConsentStore(this.db);
    const candidates = await this.db.prepare(`SELECT id FROM pending_approvals WHERE ${cond}`).all(tool, argv_hash, profile, token_id, cwd, now) as {id:string}[];
    for (const {id} of candidates) {
      const row=(await consent.get(id))!;
      if(row.level==='strong' && (consent.digest(row)!==row.op_digest || createHash('sha256').update(JSON.stringify(['v2',row.tool,row.cwd,JSON.parse(row.argv_json)])).digest('hex')!==argv_hash)) {
        await this.db.prepare("UPDATE pending_approvals SET status='rejected',rejected_reason='binding_refused' WHERE id=? AND status='approved'").run(id);
      }
    }
    const rows = await this.db
      .prepare(
        `UPDATE pending_approvals
            SET status = 'reserved', reserved_at = ?
          WHERE id = (SELECT id FROM pending_approvals WHERE ${cond}
                       ORDER BY approved_at DESC LIMIT 1)
            AND ${cond}
        RETURNING id`,
      )
      .all(now, tool, argv_hash, profile, token_id, cwd, now, tool, argv_hash, profile, token_id, cwd, now) as Array<{ id: string }>;
    return rows.length === 1 ? rows[0]!.id : null;
  }

  /** Id of a live approved row for tool+argv_hash regardless of binding.
   *  Used only to detect (and log) a binding mismatch; never to consume. */
  async findApprovedAnyBinding(tool: string, argv_hash: string, now: number): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM pending_approvals
          WHERE tool = ? AND argv_hash = ? AND status = 'approved'
            AND consumed_at IS NULL AND expires_at > ?
          ORDER BY approved_at DESC LIMIT 1`,
      )
      .get(tool, argv_hash, now) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** reserved → consumed. Called once the child process has spawned; from
   *  then on the approval is spent whatever the exit code. */
  async finalizeApproval(id: string, now: number): Promise<boolean> {
    const info = await this.db
      .prepare(
        `UPDATE pending_approvals SET status = 'consumed', consumed_at = ?
          WHERE id = ? AND kind = 'passthrough' AND status = 'reserved'`,
      )
      .run(now, id);
    return info.changes > 0;
  }

  /** reserved → approved. Only for a confirmed pre-spawn failure (no process
   *  ever started). A consumed or expired row is never returned to approved. */
  async releaseApproval(id: string): Promise<boolean> {
    const info = await this.db
      .prepare(
        `UPDATE pending_approvals SET status = 'approved', reserved_at = NULL
          WHERE id = ? AND kind = 'passthrough' AND status = 'reserved'`,
      )
      .run(id);
    return info.changes > 0;
  }

  /** Expire reservations that were never settled (reserved_at <= cutoff),
   *  e.g. after a crash between reserve and spawn. Never reverts them to
   *  approved: an unsettled reservation may have spawned. Reports per tool. */
  async expireStaleReservations(cutoff: number): Promise<Array<{ tool: string; count: number }>> {
    return await this.db.transaction(async () => {
      const per = await this.db
        .prepare(
          `SELECT tool, COUNT(*) AS count FROM pending_approvals
            WHERE status = 'reserved' AND reserved_at <= ? GROUP BY tool`,
        )
        .all(cutoff) as Array<{ tool: string; count: number }>;
      if (per.length > 0) {
        await this.db
          .prepare(
            `UPDATE pending_approvals SET status = 'expired'
              WHERE status = 'reserved' AND reserved_at <= ?`,
          )
          .run(cutoff);
      }
      return per;
    })();
  }

  async approveApproval(id: string, by: string | null, now: number): Promise<boolean> {
    const info = await this.db
      .prepare(
        `UPDATE pending_approvals
            SET status = 'approved', approved_at = ?, approved_by = ?, consent_method = 'admin_api'
          WHERE id = ? AND status = 'pending' AND level != 'strong' AND expires_at > ?`,
      )
      .run(now, by, id, now);
    return info.changes > 0;
  }

  /** Operator rejection. Also accepts an approval a standing grant superseded
   *  (once), so the caller can still revoke that grant; its reason is kept. */
  async rejectApproval(id: string, by: string | null, now: number): Promise<boolean> {
    const info = await this.db
      .prepare(
        `UPDATE pending_approvals
            SET status = 'rejected', approved_at = ?, approved_by = ?
          WHERE id = ?
            AND (status = 'pending'
                 OR (status = 'rejected' AND rejected_reason = 'superseded_by_grant' AND approved_at IS NULL))`,
      )
      .run(now, by, id);
    return info.changes > 0;
  }

  async getApproval(id: string): Promise<ApprovalRow | null> {
    const row = await this.db
      .prepare(
        `SELECT id, tool, argv_hash, argv_json, rule, matched, status,
                requested_at, expires_at, approved_at, approved_by, consumed_at, profile, cwd, approval_context, consent_method
           FROM pending_approvals WHERE id = ?`,
      )
      .get(id) as ApprovalRowRaw | undefined;
    return row ? mapApproval(row) : null;
  }

  async listApprovals(opts: { status?: string; limit?: number } = {}): Promise<ApprovalRow[]> {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    const rows = (opts.status
      ? await this.db
          .prepare(
            `SELECT id, tool, argv_hash, argv_json, rule, matched, status,
                    requested_at, expires_at, approved_at, approved_by, consumed_at, profile, cwd, approval_context, consent_method
               FROM pending_approvals
              WHERE status = ?
              ORDER BY requested_at DESC LIMIT ?`,
          )
          .all(opts.status, limit)
      : await this.db
          .prepare(
            `SELECT id, tool, argv_hash, argv_json, rule, matched, status,
                    requested_at, expires_at, approved_at, approved_by, consumed_at, profile, cwd, approval_context, consent_method
               FROM pending_approvals
              ORDER BY requested_at DESC LIMIT ?`,
          )
          .all(limit)) as ApprovalRowRaw[];
    return rows.map(mapApproval);
  }

  /** Sweep rows whose expires_at has passed. Returns the count affected. */
  async expireOverdue(now: number): Promise<number> {
    return (await this.expireOverdueByTool(now)).reduce((n, r) => n + r.count, 0);
  }

  /** Like expireOverdue but reports the affected count per tool. */
  async expireOverdueByTool(now: number): Promise<Array<{ tool: string; count: number }>> {
    return await this.db.transaction(async () => {
      const per = await this.db
        .prepare(
          `SELECT tool, COUNT(*) AS count FROM pending_approvals
            WHERE status IN ('pending', 'approved') AND expires_at <= ? GROUP BY tool`,
        )
        .all(now) as Array<{ tool: string; count: number }>;
      if (per.length > 0) {
        await this.db
          .prepare(
            `UPDATE pending_approvals SET status = 'expired'
              WHERE status IN ('pending', 'approved') AND expires_at <= ?`,
          )
          .run(now);
      }
      return per;
    })();
  }

  /**
   * Add one replica's counter increments to the shared row without losing a
   * concurrent replica's. Counters use `col = col + excluded.col` (atomic on
   * both backends); rule_denies is merged under the row lock that the upsert
   * takes for the rest of the transaction. Hourly buckets are aligned by absolute
   * hour and summed (see mergeWindows: same rule as the totals). Minute buckets
   * stay last-writer-wins. Returns the merged row.
   */
  async addMetricsDelta(d: MetricsDelta): Promise<MetricsSnapshotRow> {
    return await this.db.transaction(async () => {
      await this.db.prepare(
        `INSERT INTO metrics_snapshots (
            tool_name, total, allow, deny, rule_denies_json,
            buckets_60s_json, buckets_1h_json, last_ts, last_duration_ms, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tool_name) DO UPDATE SET
           total            = metrics_snapshots.total + excluded.total,
           allow            = metrics_snapshots.allow + excluded.allow,
           deny             = metrics_snapshots.deny + excluded.deny,
           buckets_60s_json = excluded.buckets_60s_json,
           last_duration_ms = CASE WHEN excluded.last_ts IS NOT NULL
             AND (metrics_snapshots.last_ts IS NULL OR excluded.last_ts >= metrics_snapshots.last_ts)
             THEN COALESCE(excluded.last_duration_ms, metrics_snapshots.last_duration_ms)
             ELSE metrics_snapshots.last_duration_ms END,
           last_ts          = CASE WHEN excluded.last_ts IS NOT NULL
             AND (metrics_snapshots.last_ts IS NULL OR excluded.last_ts >= metrics_snapshots.last_ts)
             THEN excluded.last_ts ELSE metrics_snapshots.last_ts END,
           updated_at       = excluded.updated_at`,
      ).run(
        // '[]' + NULL anchor marks a row created by this very delta (legacy rows hold 24 entries).
        d.tool_name, d.total, d.allow, d.deny, '{}',
        JSON.stringify(d.buckets_60s), '[]',
        d.last_ts, d.last_duration_ms, Date.now(),
      );
      // The upsert holds the row lock until commit, so this read-merge-write is serialised.
      const cur = await this.getMetricsSnapshot(d.tool_name) as MetricsSnapshotRow;
      const merged = { ...cur.rule_denies };
      for (const [rule, n] of Object.entries(d.rule_denies)) merged[rule] = (merged[rule] ?? 0) + n;
      if (Object.keys(d.rule_denies).length > 0) {
        await this.db.prepare('UPDATE metrics_snapshots SET rule_denies_json = ? WHERE tool_name = ?')
          .run(JSON.stringify(merged), d.tool_name);
      }
      const hourly = mergeHourly(cur, d);
      await this.db.prepare(
        'UPDATE metrics_snapshots SET buckets_1h_json = ?, buckets_1h_anchor = ?, buckets_1h_from = ? WHERE tool_name = ?',
      ).run(JSON.stringify(hourly.buckets), hourly.anchor, hourly.from, d.tool_name);
      const row: MetricsSnapshotRow = {
        ...cur, rule_denies: merged,
        buckets_1h: [...hourly.buckets], buckets_1h_anchor: hourly.anchor, buckets_1h_from: hourly.from,
      };
      return row;
    })();
  }

  async upsertMetricsSnapshot(snapshot: Omit<MetricsSnapshotRow, 'updated_at'>): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO metrics_snapshots (
            tool_name, total, allow, deny, rule_denies_json,
            buckets_60s_json, buckets_1h_json, buckets_1h_anchor, buckets_1h_from,
            last_ts, last_duration_ms, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tool_name) DO UPDATE SET
           total            = excluded.total,
           allow            = excluded.allow,
           deny             = excluded.deny,
           rule_denies_json = excluded.rule_denies_json,
           buckets_60s_json = excluded.buckets_60s_json,
           buckets_1h_json  = excluded.buckets_1h_json,
           buckets_1h_anchor = excluded.buckets_1h_anchor,
           buckets_1h_from  = excluded.buckets_1h_from,
           last_ts          = excluded.last_ts,
           last_duration_ms = excluded.last_duration_ms,
           updated_at       = excluded.updated_at`,
      )
      .run(
        snapshot.tool_name,
        snapshot.total,
        snapshot.allow,
        snapshot.deny,
        JSON.stringify(snapshot.rule_denies),
        JSON.stringify(snapshot.buckets_60s),
        JSON.stringify(snapshot.buckets_1h),
        snapshot.buckets_1h_anchor ?? null,
        snapshot.buckets_1h_from ?? null,
        snapshot.last_ts,
        snapshot.last_duration_ms,
        Date.now(),
      );
  }
}

/**
 * Combine the stored hourly window with a replica's delta, by absolute hour.
 * Row just created by this delta: all-zero base that is known from 23h back
 * (no earlier calls existed). Legacy row (data but no anchor): its hours cannot
 * be placed in time, so the base is zeros known only from the delta's hour.
 */
function mergeHourly(cur: MetricsSnapshotRow, d: MetricsDelta): HourlyWindow {
  const dAnchor = d.buckets_1h_anchor ?? hourOf(Date.now());
  const incoming = windowFromRow(d.buckets_1h, dAnchor, d.buckets_1h_from ?? dAnchor - (HOURS - 1));
  if (cur.buckets_1h_anchor == null) {
    const fresh = cur.buckets_1h.length === 0;
    return mergeWindows(emptyWindow(dAnchor, fresh ? dAnchor - (HOURS - 1) : dAnchor), incoming);
  }
  return mergeWindows(windowFromRow(cur.buckets_1h, cur.buckets_1h_anchor, cur.buckets_1h_from ?? cur.buckets_1h_anchor), incoming);
}

interface ApprovalRowRaw {
  id: string;
  tool: string;
  argv_hash: string;
  argv_json: string;
  rule: string;
  matched: string | null;
  status: string;
  requested_at: number;
  expires_at: number;
  approved_at: number | null;
  approved_by: string | null;
  consumed_at: number | null;
  profile: string | null;
  cwd: string | null;
  approval_context?: string | null;
  consent_method?: string | null;
}

function mapApproval(r: ApprovalRowRaw): ApprovalRow {
  let argv: string[] = [];
  try {
    const parsed = JSON.parse(r.argv_json);
    if (Array.isArray(parsed)) argv = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    /* malformed → empty argv; logged on insert path */
  }
  return {
    id: r.id,
    tool: r.tool,
    argv_hash: r.argv_hash,
    argv,
    rule: r.rule,
    matched: r.matched,
    status: r.status as ApprovalRow['status'],
    requested_at: r.requested_at,
    expires_at: r.expires_at,
    approved_at: r.approved_at,
    approved_by: r.approved_by,
    consumed_at: r.consumed_at,
    profile: r.profile,
    cwd: r.cwd,
    approval_context: r.approval_context,
    consent_method: r.consent_method,
  };
}

function safeParseObj(s: string): Record<string, number> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function safeParseArr(s: string): number[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as number[]) : [];
  } catch {
    return [];
  }
}
