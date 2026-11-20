import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mintGitHubAppToken, signAppJwt } from '../../../scripts/mint/github-app-token.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let server: Server;
let apiBase: string;
let requests: Array<{ method: string; path: string; auth?: string; body: Record<string, unknown> }> = [];
let routes: Record<string, { status: number; json: unknown }> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
      });
      const result = routes[`${req.method} ${req.url}`] ?? { status: 404, json: { message: 'not found' } };
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.json));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { server.close(); });

beforeEach(() => {
  requests = [];
  routes = {};
});

function verifyJwt(jwt: string): Record<string, unknown> {
  const [header, payload, signature] = jwt.split('.');
  const verifier = createVerify('RSA-SHA256').update(`${header}.${payload}`);
  expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('github-app-token mint script', () => {
  it('signs an App JWT and exchanges it for an installation token', async () => {
    const now = 1_800_000_000_000;
    routes['POST /app/installations/42/access_tokens'] = {
      status: 201,
      json: { token: 'ghs_installation', expires_at: new Date(now + 3_600_000).toISOString(), permissions: { contents: 'write' } },
    };
    const result = await mintGitHubAppToken({ appId: '123', privateKey: PEM, installationId: '42', apiBase, now });

    expect(result.token).toBe('ghs_installation');
    expect(result.expires_in).toBe(3600);
    expect(result.installation_id).toBe('42');
    const auth = requests[0]!.auth ?? '';
    expect(auth.startsWith('Bearer ')).toBe(true);
    const payload = verifyJwt(auth.slice('Bearer '.length));
    expect(payload['iss']).toBe('123');
    expect(payload['exp']).toBeGreaterThan(payload['iat'] as number);
  });

  it('looks the installation up when no id is configured', async () => {
    routes['GET /app/installations'] = { status: 200, json: [{ id: 7, account: { login: 'x' } }] };
    routes['POST /app/installations/7/access_tokens'] = { status: 201, json: { token: 'ghs_lookup', expires_at: new Date(Date.now() + 3_600_000).toISOString() } };
    const result = await mintGitHubAppToken({ appId: '123', privateKey: PEM, apiBase });
    expect(result.token).toBe('ghs_lookup');
    expect(result.installation_id).toBe('7');
  });

  it('scopes the token to repositories when asked', async () => {
    routes['POST /app/installations/42/access_tokens'] = { status: 201, json: { token: 'ghs_scoped', expires_at: new Date(Date.now() + 3_600_000).toISOString() } };
    await mintGitHubAppToken({ appId: '1', privateKey: PEM, installationId: '42', repositories: ['example-repo'], apiBase });
    expect(requests[0]!.body).toEqual({ repositories: ['example-repo'] });
  });

  it('accepts a PEM with literal backslash-n escapes', async () => {
    expect(() => signAppJwt({ appId: '1', privateKey: PEM.replace(/\n/g, '\\n'), now: Date.now() })).not.toThrow();
  });

  it('fails closed without credentials', async () => {
    await expect(mintGitHubAppToken({ appId: '', privateKey: PEM, apiBase })).rejects.toThrow('github_app_id_missing');
    await expect(mintGitHubAppToken({ appId: '1', privateKey: '', apiBase })).rejects.toThrow('github_app_key_missing');
  });

  it('surfaces a GitHub error instead of a token', async () => {
    routes['POST /app/installations/42/access_tokens'] = { status: 403, json: { message: 'forbidden' } };
    await expect(mintGitHubAppToken({ appId: '1', privateKey: PEM, installationId: '42', apiBase })).rejects.toThrow('github_token_403');
  });
});
