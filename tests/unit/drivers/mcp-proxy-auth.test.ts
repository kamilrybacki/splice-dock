import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  staticResolve: vi.fn(async (ref: string) => `static(${ref})`),
  mintResolve: vi.fn(async (source: unknown) => `minted(${(source as { mint: string }).mint})`),
}));

vi.mock('../../../src/services/secrets/adapters/vault/resolver.js', () => ({ resolveAuthValue: mocks.staticResolve }));
vi.mock('../../../src/services/secrets/adapters/resolution.js', () => ({
  resolveCredentialSource: (source: { from: string } | { mint: string }, _target: unknown) =>
    'from' in source ? mocks.staticResolve(source.from) : mocks.mintResolve(source),
}));

const { buildAuthHeaders } = await import('../../../src/services/upstreams/adapters/mcp/driver.js');

const identity = { profile: 'worker', agent: 'bot' };

describe('buildAuthHeaders', () => {
  beforeEach(() => {
    mocks.staticResolve.mockClear();
    mocks.mintResolve.mockClear();
  });

  it('sends no headers for auth: none', async () => {
    expect(await buildAuthHeaders({ type: 'none' }, identity, 'vault')).toEqual({});
    expect(await buildAuthHeaders(undefined, identity, 'vault')).toEqual({});
  });

  it('resolves a static bearer reference', async () => {
    const headers = await buildAuthHeaders(
      { type: 'bearer', token: { from: 'env:VAULT_TOKEN' } },
      identity,
      'vault',
    );
    expect(headers).toEqual({ Authorization: 'Bearer static(env:VAULT_TOKEN)' });
    expect(mocks.mintResolve).not.toHaveBeenCalled();
  });

  it('resolves a minted bearer per profile, never statically', async () => {
    const headers = await buildAuthHeaders({ type: 'bearer', token: { mint: 'vault_ro' } }, identity, 'vault');
    expect(headers).toEqual({ Authorization: 'Bearer minted(vault_ro)' });
    expect(mocks.staticResolve).not.toHaveBeenCalled();
  });

  it('resolves a minted custom header', async () => {
    const headers = await buildAuthHeaders(
      { type: 'header', name: 'X-Api-Key', value: { mint: 'grafana' } },
      identity,
      'grafana',
    );
    expect(headers).toEqual({ 'X-Api-Key': 'minted(grafana)' });
  });

  it('keeps basic auth static', async () => {
    const headers = await buildAuthHeaders(
      { type: 'basic', username: { from: 'env:U' }, password: { from: 'env:P' } },
      identity,
      'netbox',
    );
    expect(headers).toEqual({
      Authorization: `Basic ${Buffer.from('static(env:U):static(env:P)').toString('base64')}`,
    });
  });
});
