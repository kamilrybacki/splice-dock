// Persistence ports for Splicedock's own state (policy overrides, runtime
// tools/profiles, profile tokens, metrics snapshots, approvals).
//
// Application services depend on these narrow repository interfaces; the
// SQLite/Postgres-backed `SplicedockStore` adapter implements all of them.
// Row shapes live here so callers never import the adapter module.

import type { CliToolPolicy, ProfileConfig, ToolConfig } from '../config/types.js';
import type { SqlDb } from './sql-db.js';

export interface PolicyOverrideRow {
  tool_name: string;
  policy: CliToolPolicy;
  updated_at: number;
  updated_by: string | null;
}

export interface MetricsSnapshotRow {
  tool_name: string;
  total: number;
  allow: number;
  deny: number;
  rule_denies: Record<string, number>;
  buckets_60s: number[];
  buckets_1h: number[];
  last_ts: number | null;
  last_duration_ms: number | null;
  updated_at: number;
}

/** Increments accrued by one replica since its last flush. */
export interface MetricsDelta {
  tool_name: string;
  total: number;
  allow: number;
  deny: number;
  rule_denies: Record<string, number>;
  buckets_60s: number[];
  buckets_1h: number[];
  last_ts: number | null;
  last_duration_ms: number | null;
}

export type RuntimeToolDriver = 'http' | 'cli' | 'mcp_proxy';

export interface RuntimeToolRow {
  id: string;
  driver: RuntimeToolDriver;
  config: ToolConfig;
  created_at: number;
  created_by: string | null;
}

export type ProfileOrigin = 'file' | 'runtime';

export interface RuntimeProfileRow {
  name: string;
  /** Legacy compatibility data and read fallback. Saves always write the full parsed profile too. */
  tools: string[];
  manifest_yaml: string | null;
  revision: number;
  origin: ProfileOrigin;
  updated_at: number;
  updated_by: string | null;
}

export type RuntimeProfileWriteResult =
  | { status: 'ok'; row: RuntimeProfileRow }
  | { status: 'conflict'; current: RuntimeProfileRow | null };

/** A profile token as listed to admins — never carries the token or its hash. */
export interface ProfileTokenRow {
  id: string;
  profile: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  revoked_by: string | null;
  created_by: string | null;
  rotated_from: string | null;
  /** Operator-set agent label; NULL for legacy tokens. */
  agent: string | null;
}

export interface RuntimeFingerprint {
  readonly tools: string;
  readonly profiles: string;
  readonly policy: string;
}

export interface ApprovalRowInsert {
  id: string;
  tool: string;
  argv_hash: string;
  argv_json: string;
  rule: string;
  matched: string | null;
  requested_at: number;
  expires_at: number;
  /** Caller binding: profile + non-secret token id. */
  profile: string;
  token_id: string;
  /** Realpath of the directory the command will be spawned in. */
  cwd: string;
}

export interface ApprovalRow {
  id: string;
  tool: string;
  argv_hash: string;
  argv: string[];
  rule: string;
  matched: string | null;
  status: 'pending' | 'approved' | 'reserved' | 'rejected' | 'expired' | 'consumed' | 'failed';
  requested_at: number;
  expires_at: number;
  approved_at: number | null;
  approved_by: string | null;
  consumed_at: number | null;
  /** Profile the request was made under (null for pre-binding rows). token_id is never exposed. */
  profile: string | null;
  /** Resolved working directory (null for rows created before the cwd binding; never consumable). */
  cwd: string | null;
  approval_context?: string | null;
  consent_method?: string | null;
}

export interface ToolCount {
  tool: string;
  count: number;
}

/** Access to the shared SQL handle for application modules that own their own tables. */
export interface SqlDatabaseProvider {
  consentDatabase(): SqlDb;
}

export interface PolicyOverrideRepository {
  getPolicyOverride(tool: string): Promise<CliToolPolicy | null>;
  setPolicyOverride(tool: string, policy: CliToolPolicy, updatedBy: string | null): Promise<void>;
  deletePolicyOverride(tool: string): Promise<boolean>;
  getProfilePolicyOverride(tool: string, profile: string): Promise<CliToolPolicy | null>;
  listProfilePolicyOverrideProfiles(tool: string): Promise<string[]>;
  setProfilePolicyOverride(tool: string, profile: string, policy: CliToolPolicy, updatedBy: string | null): Promise<void>;
  deleteProfilePolicyOverride(tool: string, profile: string): Promise<boolean>;
}

export interface RuntimeToolRepository {
  listRuntimeTools(): Promise<RuntimeToolRow[]>;
  upsertRuntimeTool(id: string, driver: RuntimeToolDriver, config: ToolConfig, createdBy?: string | null): Promise<void>;
  deleteRuntimeTool(id: string): Promise<boolean>;
}

export interface RuntimeProfileRepository {
  listRuntimeProfiles(): Promise<RuntimeProfileRow[]>;
  saveRuntimeProfile(
    name: string,
    profile: ProfileConfig,
    manifest: string,
    updatedBy: string | null,
    baseRevision: number,
    origin?: ProfileOrigin,
  ): Promise<RuntimeProfileWriteResult>;
  isConfigProfileDeleted(name: string): Promise<boolean>;
}

export interface ProfileTokenRepository extends SqlDatabaseProvider {
  configureTokenTouch(seconds: number): void;
  listProfileTokens(): Promise<ProfileTokenRow[]>;
  sweepInactiveTokens(
    now: number,
    mode: 'observe' | 'enforce',
    days?: number,
  ): Promise<{ revoked: number; wouldRevoke: number }>;
}

export interface MetricsRepository {
  addMetricsDelta(delta: MetricsDelta): Promise<MetricsSnapshotRow>;
  listMetricsSnapshots(): Promise<MetricsSnapshotRow[]>;
}

export interface ApprovalRepository extends SqlDatabaseProvider {
  insertApproval(row: ApprovalRowInsert): Promise<void>;
  findPendingFor(
    tool: string,
    argv_hash: string,
    profile: string,
    token_id: string,
    cwd: string,
    now: number,
    lock?: boolean,
  ): Promise<{ id: string; expires_at: number } | null>;
  reserveBoundApproval(
    tool: string,
    argv_hash: string,
    profile: string,
    token_id: string,
    cwd: string,
    now: number,
    allowStrong?: boolean,
    requireStrong?: boolean,
  ): Promise<string | null>;
  findApprovedAnyBinding(tool: string, argv_hash: string, now: number): Promise<string | null>;
  finalizeApproval(id: string, now: number): Promise<boolean>;
  releaseApproval(id: string): Promise<boolean>;
  expireStaleReservations(cutoff: number): Promise<ToolCount[]>;
  approveApproval(id: string, by: string | null, now: number): Promise<boolean>;
  rejectApproval(id: string, by: string | null, now: number): Promise<boolean>;
  getApproval(id: string): Promise<ApprovalRow | null>;
  listApprovals(opts?: { status?: string; limit?: number }): Promise<ApprovalRow[]>;
  expireOverdueByTool(now: number): Promise<ToolCount[]>;
}

export interface RuntimeFingerprintSource {
  runtimeFingerprint(): Promise<RuntimeFingerprint>;
}
