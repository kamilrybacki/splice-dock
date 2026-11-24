// Shared type definitions for the admin WebUI.

import type { AdminTokenSet } from '../auth.js';
import type { AuditEntry } from '../../../../audit/base.js';

export interface WebUiOptions {
  expectedToken: string;
  /** All accepted admin tokens (legacy + named). Defaults to just `expectedToken`. */
  tokens?: AdminTokenSet;
  /** Shared secret injected by Caddy after Authelia validates. Enables SSO auto-login. */
  autheliaBypassSecret?: string;
  /** Called when a request needs current snapshot data — supplied by server.ts. */
  snapshot: () => Promise<{
    policies: Array<{
      tool: string;
      file_policy: unknown;
      override: unknown;
      effective: unknown;
    }>;
    recent_denies: Array<{ ts: number; tool: string; rule?: string }>;
    metrics: Array<{
      tool: string;
      total: number;
      allow: number;
      deny: number;
      calls_in_window?: number;
      buckets_24h?: number[];
    }>;
  }>;
  detail: (tool: string, profile?: string) => Promise<{
    profiles: string[];
    profile: string | null;
    profile_override: unknown;
    view: {
      profile_overrides: string[];
      tool: string;
      file_policy: unknown;
      override: unknown;
      effective: unknown;
    };
    metric: {
      total: number;
      allow: number;
      deny: number;
      rule_denies: Record<string, number>;
      buckets_1h: number[];
    } | null;
    recent: Array<{ ts: number; tool: string; decision: 'allow' | 'deny' | 'approval'; rule?: string; argv_len?: number }>;
  } | null>;
  auditList: (limit: number, tool?: string) => Promise<AuditEntry[]>;
  metricsList: () => Promise<
    Array<{ tool: string; total: number; allow: number; deny: number; rule_denies: Record<string, number>; last_ts: number | null }>
  >;
  grantsEnabled?: boolean;
  approvalsList?: (status?: string) => Promise<
    Array<{
      id: string;
      tool: string;
      argv: string[];
      rule: string;
      matched: string | null;
      status: 'pending' | 'approved' | 'rejected' | 'expired' | 'reserved' | 'consumed' | 'failed';
      requested_at: number;
      expires_at: number;
      cwd: string | null;
      approval_context?: string | null;
      consent_method?: string | null;
    }>
  >;
  approvalDetail?: (id: string) => Promise<
    | {
        id: string;
        tool: string;
        argv: string[];
        rule: string;
        matched: string | null;
        status: 'pending' | 'approved' | 'rejected' | 'expired' | 'reserved' | 'consumed' | 'failed';
        requested_at: number;
        expires_at: number;
        approved_at: number | null;
        approved_by: string | null;
        consumed_at: number | null;
        cwd: string | null;
      approval_context?: string | null;
      consent_method?: string | null;
      }
    | null
  >;
}
