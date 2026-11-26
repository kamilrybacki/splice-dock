import { logger } from './common/logger.js';

/** The only place that interprets these process environment variables for the services. */
export type Env = Readonly<Record<string, string | undefined>>;

/** APPROVAL_TTL_SEC: positive integer seconds, returned as ms; anything else means "use config". */
export function approvalTtlMsFromEnv(env: Env): number | undefined {
  const raw = env['APPROVAL_TTL_SEC'];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

/** SPLICEDOCK_GRANTS=1 enables approval grants. */
export function grantsEnabledFromEnv(env: Env): boolean {
  return env['SPLICEDOCK_GRANTS'] === '1';
}

const K8S_NAMESPACE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/**
 * SPLICEDOCK_GRANT_NAMESPACES (ADR 0010): comma-separated exact namespace names in
 * which standing grants may form and match. Unset or empty means none (default-deny).
 * Entries are trimmed; empty ones are dropped; invalid ones are rejected with a warning.
 */
export function grantNamespacesFromEnv(env: Env): string[] {
  const valid: string[] = [];
  for (const entry of (env['SPLICEDOCK_GRANT_NAMESPACES'] ?? '').split(',').map(e => e.trim()).filter(Boolean)) {
    if (K8S_NAMESPACE.test(entry)) { if (!valid.includes(entry)) valid.push(entry); }
    else logger.warn('SPLICEDOCK_GRANT_NAMESPACES: ignoring invalid namespace name', { entry });
  }
  return valid;
}

/** SPLICEDOCK_SHADOW=off disables the shadow observer regardless of config. Read live. */
export function shadowKillSwitchFromEnv(env: Env): boolean {
  return env['SPLICEDOCK_SHADOW'] === 'off';
}
