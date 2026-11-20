import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../common/logger.js';

/**
 * Resolves auth references at call time.
 * NEVER cache resolved values. NEVER log resolved values.
 *
 * Supported formats:
 *   env:FOO                             — read FOO from process env
 *   vault:secret/data/example/github    — read 'value' field from Vault KV v2
 *   vault:secret/data/example/github#runner_pat
 *                                       — read 'runner_pat' field from Vault KV v2
 */
export async function resolveAuthValueRaw(from: string, signal?: AbortSignal): Promise<string> {
  if (from.startsWith('env:')) {
    const varName = from.slice(4);
    const value = process.env[varName];
    if (!value) throw new Error('secret_missing');
    return value;
  }
  if (from.startsWith('vault:')) {
    return resolveVaultSecret(from.slice(6), signal);
  }
  throw new Error('secret_missing');
}

async function resolveVaultSecret(ref: string, signal?: AbortSignal): Promise<string> {
  // `secret/data/example/github#runner_pat` — path before #, field after.
  const [path, field = 'value'] = ref.split('#');
  const addr = discoverVaultAddr();
  if (!addr) throw new Error('VAULT_ADDR not found in env');
  const token = await discoverVaultToken(addr, signal);
  if (!token) throw new Error('VAULT_TOKEN not found in env, or AppRole (~/.vault-approle.yml), or ~/.vault-token');
  const response = await fetch(`${addr}/v1/${path}`, {
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    signal: signal ?? AbortSignal.timeout(3_000),
  });
  if (!response.ok) {
    if (response.status === 404) {
      logger.warn('vault secret not found');
      throw new Error('secret_missing');
    }
    logger.warn('vault request failed', { status: response.status });
    throw new Error(`Vault returned HTTP ${response.status}`);
  }
  const body = await response.json() as { data?: { data?: Record<string, string> } };
  const value = body?.data?.data?.[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error('secret_missing');
  }
  return value;
}

/** Discover VAULT_ADDR from the environment. */
export function discoverVaultAddr(): string | undefined {
  return process.env['VAULT_ADDR'] || undefined;
}

/**
 * Token precedence: VAULT_TOKEN env, AppRole (VAULT_ROLE_ID/VAULT_SECRET_ID env or
 * ~/.vault-approle.yml), ~/.vault-token, then (in a pod) Kubernetes
 * auth with the projected ServiceAccount token. AppRole and Kubernetes tokens are cached
 * in memory and re-issued before expiry; never persisted or logged.
 */
export async function discoverVaultToken(addr: string, signal?: AbortSignal): Promise<string | undefined> {
  if (process.env['VAULT_TOKEN']) return process.env['VAULT_TOKEN'];
  const approle = discoverAppRole();
  if (approle) {
    try {
      return await appRoleToken(addr, approle, signal);
    } catch {
      // A stale AppRole (expired secret_id, rotated role) must not shadow a valid
      // ~/.vault-token: fall through to the file sources instead of failing every
      // vault: reference.
      logger.warn('vault approle login failed; falling back to token files');
    }
  }
  try {
    const raw = readFileSync(join(homedir(), '.vault-token'), 'utf-8').trim();
    if (raw) return raw;
  } catch { /* not present */ }
  return kubernetesToken(addr, signal);
}

interface AppRoleCreds { roleId: string; secretId: string }
interface CachedToken { token: string; expiresAt: number }

const APPROLE_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_K8S_SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const DEFAULT_K8S_ROLE = 'splicedock';
let cachedAppRoleToken: CachedToken | undefined;
let cachedK8sToken: CachedToken | undefined;

/** Test hook. */
export function resetVaultTokenCache(): void {
  cachedAppRoleToken = undefined;
  cachedK8sToken = undefined;
}

/**
 * Last-resort source for in-cluster pods: exchange the projected ServiceAccount token at
 * auth/kubernetes/login (role SPLICEDOCK_VAULT_K8S_ROLE, same default as the vault-token
 * mint script). Outside a pod the SA token file is absent and this returns undefined.
 * The Vault token is cached in memory until near expiry; never persisted or logged.
 */
async function kubernetesToken(addr: string, signal?: AbortSignal): Promise<string | undefined> {
  if (cachedK8sToken && cachedK8sToken.expiresAt > Date.now()) return cachedK8sToken.token;
  let jwt: string;
  try {
    jwt = readFileSync(process.env['SPLICEDOCK_SA_TOKEN_PATH'] || DEFAULT_K8S_SA_TOKEN_PATH, 'utf-8').trim();
  } catch {
    return undefined;
  }
  if (!jwt) return undefined;
  try {
    const response = await fetch(`${addr}/v1/auth/kubernetes/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt, role: process.env['SPLICEDOCK_VAULT_K8S_ROLE'] || DEFAULT_K8S_ROLE }),
      signal: signal ?? AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      logger.warn('vault kubernetes login failed', { status: response.status });
      return undefined;
    }
    const body = await response.json() as { auth?: { client_token?: string; lease_duration?: number } };
    const token = body?.auth?.client_token;
    if (!token) return undefined;
    const leaseMs = (body.auth?.lease_duration ?? 0) * 1000;
    cachedK8sToken = { token, expiresAt: Date.now() + Math.max(leaseMs - APPROLE_REFRESH_MARGIN_MS, 0) };
    return token;
  } catch {
    logger.warn('vault kubernetes login failed');
    return undefined;
  }
}

function discoverAppRole(): AppRoleCreds | undefined {
  const envRole = process.env['VAULT_ROLE_ID'];
  const envSecret = process.env['VAULT_SECRET_ID'];
  if (envRole && envSecret) return { roleId: envRole, secretId: envSecret };
  const roleId = readYmlField('role_id', '.vault-approle.yml');
  const secretId = readYmlField('secret_id', '.vault-approle.yml');
  return roleId && secretId ? { roleId, secretId } : undefined;
}

async function appRoleToken(addr: string, creds: AppRoleCreds, signal?: AbortSignal): Promise<string> {
  if (cachedAppRoleToken && cachedAppRoleToken.expiresAt > Date.now()) return cachedAppRoleToken.token;
  const response = await fetch(`${addr}/v1/auth/approle/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role_id: creds.roleId, secret_id: creds.secretId }),
    signal: signal ?? AbortSignal.timeout(3_000),
  });
  if (!response.ok) {
    logger.warn('vault approle login failed', { status: response.status });
    throw new Error(`AppRole login failed (HTTP ${response.status}) — secret_id expired? re-mint it`);
  }
  const body = await response.json() as { auth?: { client_token?: string; lease_duration?: number } };
  const token = body?.auth?.client_token;
  if (!token) throw new Error('AppRole login returned no client_token');
  const leaseMs = (body.auth?.lease_duration ?? 0) * 1000;
  cachedAppRoleToken = { token, expiresAt: Date.now() + Math.max(leaseMs - APPROLE_REFRESH_MARGIN_MS, 0) };
  return token;
}

function readYmlField(fieldName: string, file: string): string | undefined {
  try {
    const raw = readFileSync(join(homedir(), file), 'utf-8');
    // Minimal parse — matches `vault_addr: "http://..."` or `vault_token: hvs.ABC...`.
    const match = new RegExp(`^${fieldName}:\\s*["']?([^"'\\s#]+)["']?`, 'm').exec(raw);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export { requireSecret as resolveAuthValue } from './secret-guard.js';
