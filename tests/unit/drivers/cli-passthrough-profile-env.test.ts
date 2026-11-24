import { describe, it, expect, afterEach } from 'vitest';
import { callCliPassthrough, setProfileEnvResolver } from '../../../src/services/tools/adapters/cli/passthrough.js';
import { runWithCaller } from '../../../src/common/request-context.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';

function makeConfig(): CliPassthroughToolConfig {
  return {
    type: 'cli_passthrough',
    name: 'gh',
    description: 'prints the forwarded credential',
    command: 'sh',
    deny_subcommands: [],
    env: [{ name: 'GH_TOKEN', from: 'env:BASE_TOKEN' }],
    timeout_ms: 5000,
    known_subcommands: 'off',
    isolate_config: false,
  };
}

function readToken(profile: string): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  return runWithCaller({ profile, tokenId: `tok-${profile}`, authenticated: true }, () =>
    callCliPassthrough(
      makeConfig(),
      'run',
      { args: ['-c', 'printf %s "${GH_TOKEN:-}"'] },
      ['sh'],
    ),
  );
}

describe('per-profile cli_passthrough env', () => {
  afterEach(() => {
    setProfileEnvResolver(null);
    delete process.env['BASE_TOKEN'];
    delete process.env['WORKER_TOKEN'];
  });

  it('falls back to the tool-level env when the profile has no override', async () => {
    process.env['BASE_TOKEN'] = 'base-token';
    const result = await readToken('plain');
    expect(result.content[0]!.text).toBe('base-token');
  });

  it('replaces the credential for a profile with an override', async () => {
    process.env['BASE_TOKEN'] = 'base-token';
    process.env['WORKER_TOKEN'] = 'worker-token';
    setProfileEnvResolver((tool, profile) =>
      tool === 'gh' && profile === 'worker'
        ? [{ name: 'GH_TOKEN', from: 'env:WORKER_TOKEN' }]
        : undefined,
    );

    expect((await readToken('worker')).content[0]!.text).toBe('worker-token');
    expect((await readToken('plain')).content[0]!.text).toBe('base-token');
  });

  it('can add an env var the tool-level list does not declare', async () => {
    process.env['WORKER_TOKEN'] = 'worker-token';
    setProfileEnvResolver((tool, profile) =>
      tool === 'gh' && profile === 'worker'
        ? [
            { name: 'GH_TOKEN', from: 'env:WORKER_TOKEN' },
            { name: 'GH_HOST', from: 'env:WORKER_TOKEN' },
          ]
        : undefined,
    );

    const result = await runWithCaller({ profile: 'worker', tokenId: 'tok-worker', authenticated: true }, () =>
      callCliPassthrough(
        { ...makeConfig(), env: [] },
        'run',
        { args: ['-c', 'printf "%s/%s" "${GH_TOKEN:-}" "${GH_HOST:-}"'] },
        ['sh'],
      ),
    );
    expect(result.content[0]!.text).toBe('worker-token/worker-token');
  });
});
