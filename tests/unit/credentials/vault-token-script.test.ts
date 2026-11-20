import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintVaultToken } from '../../../scripts/mint/vault-token.mjs';

interface Recorded { method: string; path: string; body: Record<string, unknown>; tokenHeader?: string }

let server: Server;
let addr: string;
let recorded: Recorded[] = [];
let routes: Record<string, (body: Record<string, unknown>) => { status: number; json: unknown }> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      recorded.push({ method: req.method ?? 'GET', path: req.url ?? '', body, tokenHeader: req.headers['x-vault-token'] as string | undefined });
      const handler = routes[`${req.method} ${req.url ?? ''}`];
      const result = handler ? handler(body) : { status: 404, json: { errors: ['not found'] } };
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.json));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  addr = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { server.close(); });

beforeEach(() => {
  recorded = [];
  routes = {};
  delete process.env['VAULT_TOKEN'];
});

const okToken = (token: string, policies: string[]) => ({
  status: 200,
  json: { auth: { client_token: token, lease_duration: 3600, token_policies: policies } },
});

const policyPresent = (name: string) => ({ status: 200, json: { name, policy: 'ok' } });

describe('vault-token mint script', () => {
  it('creates a child token with the per-profile policy when that policy exists', async () => {
    routes[`GET /v1/sys/policies/acl/${encodeURIComponent('splicedock-profile-worker-devops')}`] = () => policyPresent('splicedock-profile-worker-devops');
    routes['POST /v1/auth/token/create'] = () => okToken('hvs.child', ['splicedock-profile-worker-devops']);
    const result = await mintVaultToken({ vaultAddr: addr, bootstrapToken: 'hvs.bootstrap', profile: 'worker-devops', agent: 'worker', backend: 'vault' });

    expect(result).toEqual({ token: 'hvs.child', expires_in: 3600, policies: ['splicedock-profile-worker-devops'] });
    const creates = recorded.filter(r => r.path === '/v1/auth/token/create');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.tokenHeader).toBe('hvs.bootstrap');
    expect(creates[0]!.body['policies']).toEqual(['splicedock-profile-worker-devops']);
    expect(creates[0]!.body['display_name']).toContain('worker-devops');
    expect(creates[0]!.body['renewable']).toBe(false);
  });

  it('falls back to the read-only policy for a profile without one', async () => {
    routes['POST /v1/auth/token/create'] = body => {
      const policies = body['policies'] as string[];
      return policies[0] === 'splicedock-profile-readonly'
        ? okToken('hvs.readonly', policies)
        : okToken('hvs.useless', policies);
    };
    const result = await mintVaultToken({ vaultAddr: addr, bootstrapToken: 'hvs.bootstrap', profile: 'brand-new' });

    expect(result.token).toBe('hvs.readonly');
    expect(recorded.some(r => r.path.startsWith('/v1/sys/policies/acl/'))).toBe(true);
    const creates = recorded.filter(r => r.path === '/v1/auth/token/create');
    expect(creates[0]!.body['policies']).toEqual(['splicedock-profile-readonly']);
  });

  it('bootstraps through the in-pod ServiceAccount token when no Vault token is available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'splicedock-mint-sa-'));
    const saPath = join(dir, 'token');
    writeFileSync(saPath, 'sa-jwt');
    routes['POST /v1/auth/kubernetes/login'] = () => ({ status: 200, json: { auth: { client_token: 'hvs.k8s', lease_duration: 3600 } } });
    routes['POST /v1/auth/token/create'] = () => okToken('hvs.child', ['splicedock-profile-readonly']);
    try {
      const result = await mintVaultToken({ vaultAddr: addr, profile: 'worker-devops', saTokenPath: saPath });
      expect(result.token).toBe('hvs.child');
      const login = recorded.find(r => r.path === '/v1/auth/kubernetes/login');
      expect(login?.body).toEqual({ jwt: 'sa-jwt', role: 'splicedock' });
      const create = recorded.find(r => r.path === '/v1/auth/token/create');
      expect(create?.tokenHeader).toBe('hvs.k8s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when no bootstrap identity is available', async () => {
    await expect(
      mintVaultToken({ vaultAddr: addr, profile: 'worker', saTokenPath: '/nonexistent/sa/token' }),
    ).rejects.toThrow('vault_bootstrap_missing');
  });

  it('surfaces a provider error instead of a token', async () => {
    routes['POST /v1/auth/token/create'] = () => ({ status: 403, json: { errors: ['permission denied'] } });
    await expect(
      mintVaultToken({ vaultAddr: addr, bootstrapToken: 'hvs.bootstrap', profile: 'worker' }),
    ).rejects.toThrow('vault_token_create_403');
  });
});
