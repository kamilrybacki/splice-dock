import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuthValue, resetVaultTokenCache } from '../../../src/services/secrets/adapters/vault/resolver.js';

// Redirect HOME to an empty tmp dir so the resolver's auto-discovery of ~/.vault-token and
// ~/.vault-approle.yml can't pick up real files from the dev machine and contaminate tests.
const origHome = process.env.HOME;
const fakeHome = mkdtempSync(join(tmpdir(), 'splicedock-resolver-test-'));

describe('resolveAuthValue', () => {
  beforeEach(() => {
    process.env.HOME = fakeHome;
    process.env.TEST_API_KEY = 'secret-value-123';
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    delete process.env.TEST_API_KEY;
    vi.restoreAllMocks();
  });

  it('resolves env: references from process.env', async () => {
    expect(await resolveAuthValue('env:TEST_API_KEY')).toBe('secret-value-123');
  });

  it('throws when env var is not set', async () => {
    await expect(resolveAuthValue('env:DOES_NOT_EXIST')).rejects.toThrow('secret_missing');
  });

  it('throws when env var is empty string', async () => {
    process.env.EMPTY_VAR = '';
    await expect(resolveAuthValue('env:EMPTY_VAR')).rejects.toThrow('secret_missing');
    delete process.env.EMPTY_VAR;
  });

  it('calls Vault HTTP API for vault: references', async () => {
    process.env.VAULT_ADDR = 'http://vault.test:8200';
    process.env.VAULT_TOKEN = 'test-token';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { data: { value: 'vault-secret-xyz' } } }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const result = await resolveAuthValue('vault:example/jira/token');
    expect(mockFetch).toHaveBeenCalledWith('http://vault.test:8200/v1/example/jira/token', expect.objectContaining({ headers: expect.objectContaining({ 'X-Vault-Token': 'test-token' }) }));
    expect(result).toBe('vault-secret-xyz');
    delete process.env.VAULT_ADDR; delete process.env.VAULT_TOKEN;
  });

  it('throws when Vault returns 404', async () => {
    process.env.VAULT_ADDR = 'http://vault.test:8200'; process.env.VAULT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(resolveAuthValue('vault:example/missing/path')).rejects.toThrow('secret_missing');
    delete process.env.VAULT_ADDR; delete process.env.VAULT_TOKEN;
  });

  it('throws when VAULT_ADDR is not set', async () => {
    delete process.env.VAULT_ADDR; delete process.env.VAULT_TOKEN;
    await expect(resolveAuthValue('vault:example/path')).rejects.toThrow('vault_unavailable');
  });
});

describe('resolveAuthValue — AppRole login', () => {
  const approleFile = join(fakeHome, '.vault-approle.yml');
  beforeEach(() => {
    process.env.HOME = fakeHome;
    process.env.VAULT_ADDR = 'http://vault.test:8200';
    delete process.env.VAULT_TOKEN;
    writeFileSync(approleFile, 'role_id: "rid-123"\nsecret_id: "sid-456"\n');
    resetVaultTokenCache();
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    delete process.env.VAULT_ADDR;
    rmSync(approleFile, { force: true });
    vi.restoreAllMocks();
  });

  function mockVault(): ReturnType<typeof vi.fn> {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/auth/approle/login')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ role_id: 'rid-123', secret_id: 'sid-456' });
        return { ok: true, status: 200, json: async () => ({ auth: { client_token: 'approle-tok', lease_duration: 3600 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { data: { token: 'v2-secret' } } }) };
    });
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  it('logs in with ~/.vault-approle.yml when no static token is configured', async () => {
    const mockFetch = mockVault();
    expect(await resolveAuthValue('vault:secret/data/example/v2/github/splicedock#token')).toBe('v2-secret');
    const secretCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/v1/secret/'));
    expect(secretCall?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ 'X-Vault-Token': 'approle-tok' }) }));
  });

  it('reuses the AppRole token across resolves until it nears expiry', async () => {
    const mockFetch = mockVault();
    await resolveAuthValue('vault:secret/data/a#token');
    await resolveAuthValue('vault:secret/data/b#token');
    expect(mockFetch.mock.calls.filter(([u]) => String(u).endsWith('/v1/auth/approle/login'))).toHaveLength(1);
  });

  it('prefers VAULT_TOKEN over AppRole when both are present', async () => {
    process.env.VAULT_TOKEN = 'static-tok';
    const mockFetch = mockVault();
    await resolveAuthValue('vault:secret/data/a#token');
    expect(mockFetch.mock.calls.filter(([u]) => String(u).endsWith('/v1/auth/approle/login'))).toHaveLength(0);
    delete process.env.VAULT_TOKEN;
  });

  it('surfaces a login failure clearly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }));
    await expect(resolveAuthValue('vault:secret/data/a#token')).rejects.toThrow('vault_unavailable');
  });
});

// Clean up the tmp HOME dir after the suite finishes.
afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

describe('Kubernetes auth fallback', () => {
  const home = mkdtempSync(join(tmpdir(), 'splicedock-resolver-k8s-'));
  const saPath = join(home, 'sa-token');
  const orig = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = home;
    process.env.VAULT_ADDR = 'http://vault.test:8200';
    process.env.SPLICEDOCK_SA_TOKEN_PATH = saPath;
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
    delete process.env.SPLICEDOCK_VAULT_K8S_ROLE;
    writeFileSync(saPath, 'sa-jwt\n');
    resetVaultTokenCache();
  });

  afterEach(() => {
    if (orig !== undefined) process.env.HOME = orig;
    else delete process.env.HOME;
    delete process.env.VAULT_ADDR;
    delete process.env.SPLICEDOCK_SA_TOKEN_PATH;
    delete process.env.SPLICEDOCK_VAULT_K8S_ROLE;
    rmSync(saPath, { force: true });
    vi.restoreAllMocks();
  });

  function mockVault(loginOk = true): ReturnType<typeof vi.fn> {
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/v1/auth/kubernetes/login')) {
        if (!loginOk) return { ok: false, status: 403, json: async () => ({}) };
        expect(JSON.parse(String(init?.body))).toEqual({ jwt: 'sa-jwt', role: 'splicedock' });
        return { ok: true, status: 200, json: async () => ({ auth: { client_token: 'k8s-tok', lease_duration: 3600 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { data: { value: 'v' } } }) };
    });
    vi.stubGlobal('fetch', mockFetch);
    return mockFetch;
  }

  it('logs in with the ServiceAccount token when no other token source exists', async () => {
    const mockFetch = mockVault();
    await resolveAuthValue('vault:secret/data/a#value');
    const secretCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/v1/secret/'));
    expect(secretCall?.[1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ 'X-Vault-Token': 'k8s-tok' }) }));
  });

  it('reuses the Kubernetes token until it nears expiry', async () => {
    const mockFetch = mockVault();
    await resolveAuthValue('vault:secret/data/a#value');
    await resolveAuthValue('vault:secret/data/b#value');
    expect(mockFetch.mock.calls.filter(([u]) => String(u).endsWith('/v1/auth/kubernetes/login'))).toHaveLength(1);
  });

  it('uses SPLICEDOCK_VAULT_K8S_ROLE when set', async () => {
    process.env.SPLICEDOCK_VAULT_K8S_ROLE = 'custom-role';
    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/v1/auth/kubernetes/login')) {
        expect(JSON.parse(String(init?.body)).role).toBe('custom-role');
        return { ok: true, status: 200, json: async () => ({ auth: { client_token: 'k8s-tok', lease_duration: 3600 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { data: { value: 'v' } } }) };
    });
    vi.stubGlobal('fetch', mockFetch);
    await resolveAuthValue('vault:secret/data/a#value');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not attempt Kubernetes login when VAULT_TOKEN is set', async () => {
    process.env.VAULT_TOKEN = 'static-tok';
    const mockFetch = mockVault();
    await resolveAuthValue('vault:secret/data/a#value');
    expect(mockFetch.mock.calls.filter(([u]) => String(u).endsWith('/v1/auth/kubernetes/login'))).toHaveLength(0);
    delete process.env.VAULT_TOKEN;
  });

  it('reports vault_unavailable when the login is rejected', async () => {
    mockVault(false);
    await expect(resolveAuthValue('vault:secret/data/a#value')).rejects.toThrow('vault_unavailable');
  });

  it('reports vault_unavailable outside a pod (no ServiceAccount token file)', async () => {
    rmSync(saPath, { force: true });
    const mockFetch = mockVault();
    await expect(resolveAuthValue('vault:secret/data/a#value')).rejects.toThrow('vault_unavailable');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('AppRole fallback', () => {
  const home = mkdtempSync(join(tmpdir(), 'splicedock-resolver-approle-'));
  const orig = process.env.HOME;
  const origAddr = process.env.VAULT_ADDR;

  beforeEach(() => {
    process.env.HOME = home;
    process.env.VAULT_ADDR = 'http://vault.test:8200';
    delete process.env.VAULT_TOKEN;
    delete process.env.VAULT_ROLE_ID;
    delete process.env.VAULT_SECRET_ID;
    writeFileSync(join(home, '.vault-approle.yml'), 'role_id: rid\nsecret_id: sid\n');
    writeFileSync(join(home, '.vault-token'), 'file-token\n');
  });

  afterEach(() => {
    if (orig !== undefined) process.env.HOME = orig;
    else delete process.env.HOME;
    if (origAddr !== undefined) process.env.VAULT_ADDR = origAddr;
    else delete process.env.VAULT_ADDR;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('falls through to ~/.vault-token when the AppRole secret_id is stale', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { data: { value: 'from-file' } } }) }));
    await expect(resolveAuthValue('vault:secret/data/x#value')).resolves.toBe('from-file');
  });
});
