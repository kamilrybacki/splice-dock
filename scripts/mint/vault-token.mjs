#!/usr/bin/env node
/**
 * Mint a short-lived Vault token for one splicedock profile/agent.
 *
 * Configured as a `credential_providers` entry of type `command`, so its stdout
 * must be the JSON the broker parses:
 *   {"token":"hvs....","expires_in":3600}
 *
 * Bootstrap identity, in order:
 *   1. VAULT_TOKEN in the environment (local workstation: ~/.vault-token is read
 *      by the caller, or the variable is exported explicitly).
 *   2. Kubernetes auth: the pod's projected ServiceAccount token is exchanged at
 *      auth/kubernetes/login with SPLICEDOCK_VAULT_K8S_ROLE (default "splicedock").
 *      No long-lived credential is stored anywhere.
 *
 * The child token gets one policy per profile (SPLICEDOCK_VAULT_POLICY_PREFIX +
 * profile). If that policy does not exist, it falls back to
 * SPLICEDOCK_VAULT_FALLBACK_POLICY so a freshly created profile is read-only
 * instead of losing the tools entirely.
 *
 * Never prints the token to stderr; stdout is the credential channel only.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const DEFAULT_TTL = '1h';
const DISPLAY_NAME_MAX = 120;

export async function mintVaultToken(options) {
  const {
    vaultAddr,
    profile,
    agent = '',
    backend = '',
    prefix = 'splicedock-profile-',
    fallbackPolicy = 'splicedock-profile-readonly',
    ttl = DEFAULT_TTL,
    k8sRole = 'splicedock',
    fetchImpl = globalThis.fetch,
    bootstrapToken,
    saTokenPath = SA_TOKEN_PATH,
  } = options;

  if (!vaultAddr) throw new Error('vault_addr_missing');
  if (!profile) throw new Error('profile_missing');

  const base = vaultAddr.replace(/\/+$/, '');
  const token = bootstrapToken || (await bootstrap(base, { k8sRole, fetchImpl, saTokenPath }));

  // Vault accepts a token_create for a policy name that does not exist, but the
  // resulting token is useless (its ACL is empty). Check first and fall back:
  // a new profile must keep read access instead of losing the tool set.
  const requested = `${prefix}${profile}`;
  const policy = (await policyExists(base, requested, token, fetchImpl)) ? requested : fallbackPolicy;
  const body = {
    policies: [policy],
    ttl,
    explicit_max_ttl: ttl,
    renewable: false,
    display_name: displayName(profile, agent, backend),
    meta: { profile, agent: agent || '', backend: backend || '', minted_by: 'splicedock' },
  };

  let response = await call(base, '/v1/auth/token/create', token, body, fetchImpl);
  if (!response.ok && response.status >= 400 && response.status < 500 && policy !== fallbackPolicy) {
    // A policy that disappeared between the check and the create is still not a
    // reason to lose read access.
    response = await call(base, '/v1/auth/token/create', token, { ...body, policies: [fallbackPolicy] }, fetchImpl);
  }
  if (!response.ok) throw new Error(`vault_token_create_${response.status}`);

  const payload = await response.json();
  const minted = payload?.auth?.client_token;
  if (typeof minted !== 'string' || minted === '') throw new Error('vault_token_missing');
  const expiresIn = Number(payload?.auth?.lease_duration);
  return {
    token: minted,
    expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
    policies: payload?.auth?.token_policies ?? [policy],
  };
}

/** Requires read on sys/policies/acl/*; without it we cannot know, so use the
 *  fallback policy, which is guaranteed to exist. */
async function policyExists(base, name, token, fetchImpl) {
  try {
    const response = await fetchImpl(`${base}/v1/sys/policies/acl/${encodeURIComponent(name)}`, {
      headers: { 'X-Vault-Token': token },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function bootstrap(base, { k8sRole, fetchImpl, saTokenPath }) {
  const fromEnv = process.env['VAULT_TOKEN'];
  if (fromEnv) return fromEnv;
  const fromFile = readTokenFile();
  if (fromFile) return fromFile;

  let jwt;
  try {
    jwt = readFileSync(saTokenPath, 'utf8').trim();
  } catch {
    throw new Error('vault_bootstrap_missing');
  }
  if (!jwt) throw new Error('vault_bootstrap_missing');
  const response = await call(base, '/v1/auth/kubernetes/login', undefined, { jwt, role: k8sRole }, fetchImpl);
  if (!response.ok) throw new Error(`vault_k8s_login_${response.status}`);
  const payload = await response.json();
  const token = payload?.auth?.client_token;
  if (typeof token !== 'string' || token === '') throw new Error('vault_bootstrap_missing');
  return token;
}

/** Same discovery order as the main resolver: env, then ~/.vault-ansible.yml. */
function readVaultAddr() {
  const fromEnv = process.env['VAULT_ADDR'];
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(join(homedir(), '.vault-ansible.yml'), 'utf8');
    const match = /^vault_addr:\s*["']?([^"'\s#]+)["']?/m.exec(raw);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Local workstations: same two files the main resolver falls back to. */
function readTokenFile() {
  try {
    const raw = readFileSync(join(homedir(), '.vault-token'), 'utf8').trim();
    if (raw) return raw;
  } catch { /* not present */ }
  try {
    const raw = readFileSync(join(homedir(), '.vault-ansible.yml'), 'utf8');
    const match = /^vault_token:\s*["']?([^"'\s#]+)["']?/m.exec(raw);
    if (match?.[1]) return match[1];
  } catch { /* not present */ }
  return undefined;
}

async function call(base, path, token, body, fetchImpl) {
  return fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Vault-Token': token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

function displayName(profile, agent, backend) {
  const raw = `cellarette:${profile}:${agent || '-'}:${backend || '-'}`;
  return raw.length > DISPLAY_NAME_MAX ? raw.slice(0, DISPLAY_NAME_MAX) : raw;
}

async function main() {
  const [profile = '', agent = '', backend = ''] = process.argv.slice(2);
  const vaultAddr = readVaultAddr();
  const result = await mintVaultToken({
    vaultAddr,
    profile,
    agent,
    backend,
    prefix: process.env['SPLICEDOCK_VAULT_POLICY_PREFIX'] || undefined,
    fallbackPolicy: process.env['SPLICEDOCK_VAULT_FALLBACK_POLICY'] || undefined,
    ttl: process.env['SPLICEDOCK_VAULT_TOKEN_TTL'] || undefined,
    k8sRole: process.env['SPLICEDOCK_VAULT_K8S_ROLE'] || undefined,
  });
  process.stdout.write(`${JSON.stringify({ token: result.token, expires_in: result.expires_in })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    // Code only: the message can contain a URL, never a secret.
    process.stderr.write(`${err instanceof Error ? err.message : 'mint_failed'}\n`);
    process.exit(1);
  });
}
