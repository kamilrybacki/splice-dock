#!/usr/bin/env node
/**
 * Mint a GitHub App installation token for one splicedock profile/agent.
 *
 * Configured as a `credential_providers` entry of type `command`, so stdout is
 * the broker's credential channel:
 *   {"token":"ghs_...","expires_in":3600}
 *
 * Credentials come from the environment (never argv):
 *   GITHUB_APP_ID                 required
 *   GITHUB_APP_PRIVATE_KEY        required (PEM; literal "\n" escapes accepted)
 *   GITHUB_APP_INSTALLATION_ID    optional; looked up when absent
 *   GITHUB_APP_REPOSITORIES       optional, comma-separated repo names to scope to
 *
 * The App JWT lives ~9 minutes; the returned installation token lives ~1 hour,
 * which is what the broker caches and refreshes.
 */
import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const JWT_LIFETIME_SECONDS = 540;
const JWT_BACKDATE_SECONDS = 60;

export async function mintGitHubAppToken(options) {
  const {
    appId,
    privateKey,
    installationId,
    repositories,
    apiBase = 'https://api.github.com',
    fetchImpl = globalThis.fetch,
    now = Date.now(),
  } = options;

  if (!appId) throw new Error('github_app_id_missing');
  if (!privateKey) throw new Error('github_app_key_missing');

  const base = apiBase.replace(/\/+$/, '');
  const jwt = signAppJwt({ appId, privateKey, now });

  let targetInstallation = installationId;
  if (!targetInstallation) {
    const response = await call(`${base}/app/installations`, jwt, fetchImpl);
    if (!response.ok) throw new Error(`github_installations_${response.status}`);
    const installations = await response.json();
    const first = Array.isArray(installations) ? installations[0]?.id : undefined;
    if (first === undefined) throw new Error('github_app_not_installed');
    targetInstallation = String(first);
  }

  const body = {};
  if (repositories && repositories.length > 0) body.repositories = repositories;
  const response = await call(`${base}/app/installations/${encodeURIComponent(String(targetInstallation))}/access_tokens`, jwt, fetchImpl, body);
  if (!response.ok) throw new Error(`github_token_${response.status}`);

  const payload = await response.json();
  if (typeof payload?.token !== 'string' || payload.token === '') throw new Error('github_token_missing');
  const expiresAt = Date.parse(payload.expires_at ?? '');
  const expiresIn = Number.isFinite(expiresAt) ? Math.max(1, Math.floor((expiresAt - now) / 1000)) : 3600;
  return {
    token: payload.token,
    expires_in: expiresIn,
    installation_id: String(targetInstallation),
    permissions: payload.permissions,
  };
}

/** RS256 App JWT: iat backdated to tolerate clock skew, exp well under GitHub's 10 min cap. */
export function signAppJwt({ appId, privateKey, now }) {
  const issuedAt = Math.floor(now / 1000) - JWT_BACKDATE_SECONDS;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: issuedAt, exp: issuedAt + JWT_BACKDATE_SECONDS + JWT_LIFETIME_SECONDS, iss: String(appId) };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let signature;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(normalizeKey(privateKey), 'base64url');
  } catch {
    throw new Error('github_app_key_invalid');
  }
  return `${unsigned}.${signature}`;
}

/** Secret managers often hand back a PEM with literal backslash-n. */
function normalizeKey(privateKey) {
  return privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey;
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function call(url, jwt, fetchImpl, body) {
  return fetchImpl(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'splicedock-credential-broker',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
}

function csv(value) {
  if (!value) return undefined;
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

async function main() {
  const result = await mintGitHubAppToken({
    appId: process.env['GITHUB_APP_ID'],
    privateKey: process.env['GITHUB_APP_PRIVATE_KEY'],
    installationId: process.env['GITHUB_APP_INSTALLATION_ID'],
    repositories: csv(process.env['GITHUB_APP_REPOSITORIES']),
    apiBase: process.env['GITHUB_API_BASE'] || undefined,
  });
  process.stdout.write(`${JSON.stringify({ token: result.token, expires_in: result.expires_in })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    process.stderr.write(`${err instanceof Error ? err.message : 'mint_failed'}\n`);
    process.exit(1);
  });
}
