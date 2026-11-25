// Credentials injected into a passthrough child never come back in its output.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialBroker } from '../../../src/services/secrets/base.js';
import { memoryBroker } from '../../helpers/broker.js';
import { callCliPassthrough, configurePassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import {
  collectSecretValues,
  MIN_REDACT_LENGTH,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from '../../../src/services/tools/adapters/cli/redact.js';
import { runWithCaller } from '../../../src/common/request/context.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';

const SECRET = 'ghs_Abcdef0123456789ZYXWVU';

function makeConfig(env: CliPassthroughToolConfig['env'] = ['SPLICEDOCK_TEST_TOKEN']): CliPassthroughToolConfig {
  return {
    type: 'cli_passthrough',
    name: 'redaction-test',
    description: 'redaction test',
    command: 'sh',
    deny_subcommands: [],
    env,
    timeout_ms: 5000,
    known_subcommands: 'off',
    isolate_config: false,
  };
}

function run(script: string, config = makeConfig()): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  return runWithCaller({ profile: 'worker', tokenId: 'tok-worker', authenticated: true, agent: 'bot' }, () =>
    callCliPassthrough(config, 'run', { args: ['-c', script] }, ['sh'], broker),
  );
}

let broker: CredentialBroker;
let saved: string | undefined;
beforeEach(() => {
  broker = memoryBroker();
  saved = process.env['SPLICEDOCK_TEST_TOKEN'];
  process.env['SPLICEDOCK_TEST_TOKEN'] = SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env['SPLICEDOCK_TEST_TOKEN'];
  else process.env['SPLICEDOCK_TEST_TOKEN'] = saved;
  configurePassthrough({});
});

describe('cli_passthrough output redaction', () => {
  it('redacts the credential from stdout', async () => {
    const out = await run('printf "token=%s\\n" "$SPLICEDOCK_TEST_TOKEN"');
    expect(out.isError).toBeFalsy();
    expect(out.content[0]!.text).toBe(`token=${REDACTION_PLACEHOLDER}\n`);
  });

  it('redacts the credential from stderr', async () => {
    const out = await run('printf "warn %s\\n" "$SPLICEDOCK_TEST_TOKEN" >&2');
    expect(out.content[0]!.text).toBe(`warn ${REDACTION_PLACEHOLDER}\n`);
    expect(out.content[0]!.text).not.toContain(SECRET);
  });

  it('redacts the credential from the error text of a failing command', async () => {
    const out = await run('printf "bad %s" "$SPLICEDOCK_TEST_TOKEN" >&2; exit 3');
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toBe(`Exit 3: bad ${REDACTION_PLACEHOLDER}`);
  });

  it('redacts every occurrence', async () => {
    const out = await run('printf "%s %s" "$SPLICEDOCK_TEST_TOKEN" "$SPLICEDOCK_TEST_TOKEN"');
    expect(out.content[0]!.text).toBe(`${REDACTION_PLACEHOLDER} ${REDACTION_PLACEHOLDER}`);
  });

  it('redacts a value split across stream chunks', async () => {
    const script =
      'printf "%.10s" "$SPLICEDOCK_TEST_TOKEN"; sleep 0.3; ' +
      'printf "%s" "$SPLICEDOCK_TEST_TOKEN" | tail -c +11';
    const out = await run(script);
    expect(out.content[0]!.text).toBe(REDACTION_PLACEHOLDER);
  });

  it('redacts a value split across stderr chunks', async () => {
    const script =
      'printf "%.10s" "$SPLICEDOCK_TEST_TOKEN" >&2; sleep 0.3; ' +
      'printf "%s" "$SPLICEDOCK_TEST_TOKEN" | tail -c +11 >&2';
    const out = await run(script);
    expect(out.content[0]!.text).toBe(REDACTION_PLACEHOLDER);
  });

  it('redacts a minted credential held under an unremarkable env name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'splicedock-redact-'));
    try {
      writeFileSync(join(dir, 'mint.sh'), `#!/bin/sh\necho ${SECRET}\n`, { mode: 0o755 });
      broker = memoryBroker({
            gh: {
              type: 'command' as const,
              command: 'sh',
              args: [join(dir, 'mint.sh')],
              env_allowlist: [] as string[],
              env: [] as Array<{ name: string; from: string }>,
              timeout_ms: 5000,
              ttl_seconds: 3600,
              output: { format: 'text' as const, secret_field: 'token' },
            },
      });
      const out = await run('printf "%s" "$SESSION_KEY"', makeConfig([{ name: 'SESSION_KEY', mint: 'gh' }]));
      expect(out.content[0]!.text).toBe(REDACTION_PLACEHOLDER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves output without the credential untouched', async () => {
    const out = await run('printf "hello world"');
    expect(out.content[0]!.text).toBe('hello world');
  });

  it('does not mangle output for a short secret-named value', async () => {
    process.env['SPLICEDOCK_TEST_TOKEN'] = 'abc';
    const out = await run('printf "abc abc"');
    expect(out.content[0]!.text).toBe('abc abc');
  });

  it('does not treat an empty secret-named value as a match', async () => {
    process.env['SPLICEDOCK_TEST_TOKEN'] = '';
    const out = await run('printf "plain"');
    expect(out.content[0]!.text).toBe('plain');
  });
});

describe('collectSecretValues', () => {
  it('takes explicit names and secret-looking names, skipping short and empty values', () => {
    const values = collectSecretValues(
      { SESSION_KEY: 'explicit-value-1', GH_TOKEN: 'token-value-22', PATH: '/usr/bin:/bin:/usr/local/bin', SHORT_TOKEN: 'abc', EMPTY_SECRET: '' },
      ['SESSION_KEY'],
    );
    expect(values).toContain('explicit-value-1');
    expect(values).toContain('token-value-22');
    expect(values).not.toContain('abc');
    expect(values).not.toContain('');
    expect(values).not.toContain('/usr/bin:/bin:/usr/local/bin');
  });

  it('does not take SSH_AUTH_SOCK-style names', () => {
    expect(collectSecretValues({ SSH_AUTH_SOCK: '/run/user/1000/agent.sock' }, [])).toEqual([]);
  });

  it('adds the lines of a multi-line value', () => {
    const key = 'line-one-aaaaaaaa\nline-two-bbbbbbbb';
    const values = collectSecretValues({ PRIVATE_KEY: key }, []);
    expect(values).toEqual(expect.arrayContaining([key, 'line-one-aaaaaaaa', 'line-two-bbbbbbbb']));
  });

  it('orders longer values first so the whole value is matched', () => {
    const values = collectSecretValues({ A_TOKEN: 'secretsecret', B_TOKEN: 'secretsecret-extended' }, []);
    expect(redactSecrets('x secretsecret-extended y', values)).toBe(`x ${REDACTION_PLACEHOLDER} y`);
  });
});

describe('redactSecrets', () => {
  it('treats regex metacharacters in a value literally', () => {
    const values = collectSecretValues({ A_TOKEN: 'a.b*c+d(e)[f]' }, []);
    expect(redactSecrets('a.b*c+d(e)[f] and aXbbbcd', values)).toBe(`${REDACTION_PLACEHOLDER} and aXbbbcd`);
  });

  it('ignores values below the minimum length', () => {
    expect(MIN_REDACT_LENGTH).toBeGreaterThan(3);
    expect(redactSecrets('abc', ['abc'].filter(v => v.length >= MIN_REDACT_LENGTH))).toBe('abc');
  });

  it('drops a trailing prefix of a secret when the output was truncated', () => {
    const values = collectSecretValues({ A_TOKEN: SECRET }, []);
    const cut = `output ${SECRET.slice(0, 12)}`;
    expect(redactSecrets(cut, values, { truncated: true })).toBe(`output ${REDACTION_PLACEHOLDER}`);
    expect(redactSecrets(cut, values)).toBe(cut);
  });
});
