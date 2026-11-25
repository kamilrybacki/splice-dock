import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCommandProvider } from '../../../src/services/secrets/adapters/command/provider.js';
import { commandProviderSchema } from '../../../src/config/schema.js';
import type { CommandProviderConfig } from '../../../src/config/types.js';
import type { MintContext } from '../../../src/services/secrets/base.js';

const PROBE_SECRET = 'SPLICEDOCK_TEST_SECRET';
const PROBE_ALLOWED = 'SPLICEDOCK_TEST_ALLOWED';
const PROBE_REF = 'SPLICEDOCK_TEST_REF_SOURCE';

function providerConfig(overrides: Record<string, unknown> = {}): CommandProviderConfig {
  // Prints its whole environment, one NAME=value per line.
  return commandProviderSchema.parse({ type: 'command', command: '/usr/bin/env', ...overrides });
}

function contextFor(config: CommandProviderConfig): MintContext {
  return {
    profile: 'worker',
    agent: null,
    backend: 'gh',
    authenticated: true,
    tokenId: null,
    provider: 'probe',
    config,
  };
}

async function mintedEnv(config: CommandProviderConfig): Promise<Map<string, string>> {
  const { secret } = await createCommandProvider().mint(contextFor(config));
  const vars = new Map<string, string>();
  for (const line of secret.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) vars.set(line.slice(0, at), line.slice(at + 1));
  }
  return vars;
}

describe('command provider environment', () => {
  const saved: Record<string, string | undefined> = {};
  const touched = [PROBE_SECRET, PROBE_ALLOWED, PROBE_REF, 'LC_TIME', 'TZ', 'TMPDIR'];

  beforeEach(() => {
    for (const name of touched) saved[name] = process.env[name];
    process.env[PROBE_SECRET] = 'must-not-leak';
    process.env[PROBE_ALLOWED] = 'allowed-value';
    process.env[PROBE_REF] = 'resolved-value';
  });

  afterEach(() => {
    for (const name of touched) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('does not pass a variable that is not on the allowlist', async () => {
    const vars = await mintedEnv(providerConfig());
    expect(vars.has(PROBE_SECRET)).toBe(false);
    expect(vars.has(PROBE_ALLOWED)).toBe(false);
  });

  it('does not inherit credentials of other backends', async () => {
    const saved = { VAULT_TOKEN: process.env['VAULT_TOKEN'], VAULT_ROLE_ID: process.env['VAULT_ROLE_ID'] };
    process.env['VAULT_TOKEN'] = 'hvs.should-not-leak';
    process.env['VAULT_ROLE_ID'] = 'role-should-not-leak';
    try {
      const vars = await mintedEnv(providerConfig());
      expect(vars.has('VAULT_TOKEN')).toBe(false);
      expect(vars.has('VAULT_ROLE_ID')).toBe(false);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('passes an allowlisted variable through unchanged', async () => {
    const vars = await mintedEnv(providerConfig({ env_allowlist: [PROBE_ALLOWED] }));
    expect(vars.get(PROBE_ALLOWED)).toBe('allowed-value');
    expect(vars.has(PROBE_SECRET)).toBe(false);
  });

  it('skips an allowlisted variable that is unset instead of defining it empty', async () => {
    delete process.env[PROBE_ALLOWED];
    const vars = await mintedEnv(providerConfig({ env_allowlist: [PROBE_ALLOWED] }));
    expect(vars.has(PROBE_ALLOWED)).toBe(false);
  });

  it('keeps the base variables so ordinary commands still run', async () => {
    process.env['TZ'] = 'UTC';
    process.env['TMPDIR'] = '/tmp';
    process.env['LC_TIME'] = 'C';
    const vars = await mintedEnv(providerConfig());
    expect(vars.get('PATH')).toBe(process.env['PATH']);
    expect(vars.get('TZ')).toBe('UTC');
    expect(vars.get('TMPDIR')).toBe('/tmp');
    expect(vars.get('LC_TIME')).toBe('C');
    if (process.env['HOME'] !== undefined) expect(vars.get('HOME')).toBe(process.env['HOME']);
  });

  it('resolves env references per mint and exposes them under the declared name', async () => {
    const vars = await mintedEnv(providerConfig({ env: [{ name: 'MINT_INPUT', from: `env:${PROBE_REF}` }] }));
    expect(vars.get('MINT_INPUT')).toBe('resolved-value');
    expect(vars.has(PROBE_REF)).toBe(false);
  });

  it('lets an env reference override a base variable', async () => {
    const vars = await mintedEnv(providerConfig({ env: [{ name: 'TZ', from: `env:${PROBE_REF}` }] }));
    expect(vars.get('TZ')).toBe('resolved-value');
  });

  it('ignores an allowlisted name that only exists on Object.prototype', async () => {
    const vars = await mintedEnv(providerConfig({ env_allowlist: ['toString', 'constructor'] }));
    expect(vars.has('toString')).toBe(false);
    expect(vars.has('constructor')).toBe(false);
  });

  it('passes LC_* variables but not look-alike names', async () => {
    process.env.LC_TIME = 'C';
    process.env.LCX_PROBE = 'nope';
    try {
      const vars = await mintedEnv(providerConfig());
      expect(vars.get('LC_TIME')).toBe('C');
      expect(vars.has('LCX_PROBE')).toBe(false);
    } finally {
      delete process.env.LCX_PROBE;
    }
  });

  it('names the failing entry in the error without revealing the reference', async () => {
    delete process.env[PROBE_REF];
    await expect(
      createCommandProvider().mint(contextFor(providerConfig({ env: [{ name: 'MINT_INPUT', from: `env:${PROBE_REF}` }] }))),
    ).rejects.toThrow(/^mint_env_unresolved: MINT_INPUT$/);
  });

  it('fails the mint when an env reference cannot be resolved', async () => {
    delete process.env[PROBE_REF];
    await expect(
      createCommandProvider().mint(contextFor(providerConfig({ env: [{ name: 'MINT_INPUT', from: `env:${PROBE_REF}` }] }))),
    ).rejects.toThrow('mint_env_unresolved');
  });
});

describe('command provider env schema', () => {
  const parse = (extra: Record<string, unknown>) =>
    commandProviderSchema.safeParse({ type: 'command', command: 'x', ...extra });

  it('defaults to an empty allowlist and no extra env', () => {
    const parsed = commandProviderSchema.parse({ type: 'command', command: 'x' });
    expect(parsed.env_allowlist).toEqual([]);
    expect(parsed.env).toEqual([]);
  });

  it('accepts valid names, including lowercase ones such as http_proxy', () => {
    expect(parse({ env_allowlist: ['GH_TOKEN', 'http_proxy', '_X1'] }).success).toBe(true);
  });

  it.each(['', '1BAD', 'HAS-DASH', 'HAS SPACE', 'A=B', 'LD\u0000X'])('rejects the invalid name %j', name => {
    expect(parse({ env_allowlist: [name] }).success).toBe(false);
    expect(parse({ env: [{ name, from: 'env:X' }] }).success).toBe(false);
  });

  it('rejects an env reference that is neither env: nor vault:', () => {
    expect(parse({ env: [{ name: 'A', from: 'file:/etc/passwd' }] }).success).toBe(false);
  });

  it('rejects unknown keys on an env entry', () => {
    expect(parse({ env: [{ name: 'A', from: 'env:X', extra: 1 }] }).success).toBe(false);
  });

  it('rejects a name declared both in env_allowlist and env, and duplicates within env', () => {
    expect(parse({ env_allowlist: ['A'], env: [{ name: 'A', from: 'env:X' }] }).success).toBe(false);
    expect(parse({ env: [{ name: 'A', from: 'env:X' }, { name: 'A', from: 'env:Y' }] }).success).toBe(false);
    expect(parse({ env_allowlist: ['A', 'A'] }).success).toBe(false);
  });
});
