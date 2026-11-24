import { credentialAdapters } from '../../../src/services/secrets/adapters/index.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callCliPassthrough, setProfileEnvResolver } from '../../../src/services/tools/adapters/cli/passthrough.js';
import { configureCredentialBroker, resetCredentialBroker } from '../../../src/services/secrets/broker.js';
import { runWithCaller } from '../../../src/common/request-context.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';

let dir: string;
let counter: string;

function makeConfig(): CliPassthroughToolConfig {
  return {
    type: 'cli_passthrough',
    name: 'gh',
    description: 'prints the forwarded credential',
    command: 'sh',
    deny_subcommands: [],
    env: [],
    timeout_ms: 5000,
    known_subcommands: 'off',
    isolate_config: false,
  };
}

function configure(providers = {
  gh: {
    type: 'command' as const,
    command: 'sh',
    args: ['-c', 'n=$(cat "$0" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0"; echo tok-$n', counter],
    timeout_ms: 5000,
    ttl_seconds: 3600,
    output: { format: 'text' as const, secret_field: 'token' },
  },
}): void {
  configureCredentialBroker({ providers, storage: { type: 'memory', prefix: '' } }, credentialAdapters);
}

function printToken(): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  return runWithCaller({ profile: 'worker', tokenId: 'tok-worker', authenticated: true, agent: 'bot' }, () =>
    callCliPassthrough(makeConfig(), 'run', { args: ['-c', 'printf %s "${GH_TOKEN:-}"'] }, ['sh']),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'splicedock-mint-cli-'));
  counter = join(dir, 'counter');
  writeFileSync(counter, '0');
});

afterEach(() => {
  setProfileEnvResolver(null);
  resetCredentialBroker();
  rmSync(dir, { recursive: true, force: true });
});

describe('cli_passthrough minted env', () => {
  it('mints a credential for the calling profile', async () => {
    configure();
    setProfileEnvResolver((tool, profile) =>
      tool === 'gh' && profile === 'worker' ? [{ name: 'GH_TOKEN', mint: 'gh' }] : undefined,
    );

    expect((await printToken()).content[0]!.text).toBe('tok-1');
  });

  it('reuses the minted value on the next call', async () => {
    configure();
    setProfileEnvResolver(() => [{ name: 'GH_TOKEN', mint: 'gh' }]);

    expect((await printToken()).content[0]!.text).toBe('tok-1');
    expect((await printToken()).content[0]!.text).toBe('tok-1');
  });

  it('reports credential_unavailable when the provider cannot mint', async () => {
    configure({
      gh: {
        type: 'command',
        command: 'sh',
        args: ['-c', 'exit 4'],
        timeout_ms: 5000,
        ttl_seconds: 3600,
        output: { format: 'text', secret_field: 'token' },
      },
    });
    setProfileEnvResolver(() => [{ name: 'GH_TOKEN', mint: 'gh' }]);

    const result = await printToken();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('credential_unavailable');
  });

  it('still resolves a static reference unchanged', async () => {
    process.env['CLI_TEST_TOKEN'] = 'static-value';
    try {
      setProfileEnvResolver(() => [{ name: 'GH_TOKEN', from: 'env:CLI_TEST_TOKEN' }]);
      expect((await printToken()).content[0]!.text).toBe('static-value');
    } finally {
      delete process.env['CLI_TEST_TOKEN'];
    }
  });
});
