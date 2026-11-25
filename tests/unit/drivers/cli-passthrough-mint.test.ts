import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callCliPassthrough, configurePassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CredentialBroker } from '../../../src/services/secrets/base.js';
import { memoryBroker } from '../../helpers/broker.js';
import { runWithCaller } from '../../../src/common/request/context.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';

let dir: string;
let counter: string;
let broker: CredentialBroker;

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
    env_allowlist: [] as string[],
    env: [] as Array<{ name: string; from: string }>,
    timeout_ms: 5000,
    ttl_seconds: 3600,
    output: { format: 'text' as const, secret_field: 'token' },
  },
}): void {
  broker = memoryBroker(providers);
}

function printToken(): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  return runWithCaller({ profile: 'worker', tokenId: 'tok-worker', authenticated: true, agent: 'bot' }, () =>
    callCliPassthrough(makeConfig(), 'run', { args: ['-c', 'printf %s "${GH_TOKEN:-}"'] }, ['sh'], broker),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'splicedock-mint-cli-'));
  counter = join(dir, 'counter');
  writeFileSync(counter, '0');
  broker = memoryBroker();
});

afterEach(() => {
  configurePassthrough({});
  rmSync(dir, { recursive: true, force: true });
});

describe('cli_passthrough minted env', () => {
  it('mints a credential for the calling profile', async () => {
    configure();
    configurePassthrough({profileEnvResolver: (tool, profile) =>
      tool === 'gh' && profile === 'worker' ? [{ name: 'GH_TOKEN', mint: 'gh' }] : undefined,});

    expect((await printToken()).content[0]!.text).toBe('tok-1');
  });

  it('refuses to mint for an unauthenticated caller', async () => {
    configure();
    configurePassthrough({profileEnvResolver: () => [{ name: 'GH_TOKEN', mint: 'gh' }]});

    const result = await runWithCaller({ profile: 'worker', tokenId: 'legacy-query', authenticated: false, agent: null }, () =>
      callCliPassthrough(makeConfig(), 'run', { args: ['-c', 'printf %s "${GH_TOKEN:-}"'] }, ['sh'], broker),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('credential_identity_unauthenticated');
    expect(readFileSync(counter, 'utf8').trim()).toBe('0');
  });

  it('reuses the minted value on the next call', async () => {
    configure();
    configurePassthrough({profileEnvResolver: () => [{ name: 'GH_TOKEN', mint: 'gh' }]});

    expect((await printToken()).content[0]!.text).toBe('tok-1');
    expect((await printToken()).content[0]!.text).toBe('tok-1');
  });

  it('reports credential_unavailable when the provider cannot mint', async () => {
    configure({
      gh: {
        type: 'command',
        command: 'sh',
        args: ['-c', 'exit 4'],
        env_allowlist: [],
        env: [],
        timeout_ms: 5000,
        ttl_seconds: 3600,
        output: { format: 'text', secret_field: 'token' },
      },
    });
    configurePassthrough({profileEnvResolver: () => [{ name: 'GH_TOKEN', mint: 'gh' }]});

    const result = await printToken();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('credential_unavailable');
  });

  it('reports credential_mint_backoff on a repeat call while the provider is backing off', async () => {
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
    configurePassthrough({profileEnvResolver: () => [{ name: 'GH_TOKEN', mint: 'gh' }]});

    expect((await printToken()).content[0]!.text).toBe('credential_unavailable');
    const second = await printToken();
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toBe('credential_mint_backoff');
  });

  it('still resolves a static reference unchanged', async () => {
    process.env['CLI_TEST_TOKEN'] = 'static-value';
    try {
      configurePassthrough({profileEnvResolver: () => [{ name: 'GH_TOKEN', from: 'env:CLI_TEST_TOKEN' }]});
      expect((await printToken()).content[0]!.text).toBe('static-value');
    } finally {
      delete process.env['CLI_TEST_TOKEN'];
    }
  });
});
