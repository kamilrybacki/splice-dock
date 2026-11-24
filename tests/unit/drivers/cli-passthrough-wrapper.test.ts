import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { callCliPassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';

function mkConfig(overrides: Partial<CliPassthroughToolConfig> = {}): CliPassthroughToolConfig {
  const base: CliPassthroughToolConfig = {
    type: 'cli_passthrough',
    name: 'echo_pass',
    description: 'echo for tests',
    command: 'echo',
    deny_subcommands: [],
    env: [],
    timeout_ms: 5000,
  };
  return { ...base, ...overrides };
}

describe('callCliPassthrough — policy', () => {
  it('runs when nothing is policied', async () => {
    const r = await callCliPassthrough(
      mkConfig(),
      'run',
      { args: ['hello'] },
      ['echo'],
    );
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text.trim()).toBe('hello');
  });

  it('ignores a non-existent cwd instead of failing with spawn ENOENT', async () => {
    // A caller in another container (e.g. the other agent) may pass a cwd from
    // its own filesystem that does not exist here. It must be ignored, not fatal.
    const r = await callCliPassthrough(
      mkConfig(),
      'run',
      { args: ['hello'], cwd: '/no/such/dir/at/all-xyz' },
      ['echo'],
    );
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text.trim()).toBe('hello');
  });

  it('honors an existing cwd', async () => {
    const r = await callCliPassthrough(
      mkConfig(),
      'run',
      { args: ['hello'], cwd: '/tmp' },
      ['echo'],
    );
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text.trim()).toBe('hello');
  });

  it('blocks when cli_whitelist excludes the command', async () => {
    const r = await callCliPassthrough(mkConfig({ command: 'rm' }), 'run', { args: ['/'] }, ['echo']);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('not in cli_whitelist');
  });

  it('honors top-level legacy deny_subcommands (backward compat)', async () => {
    const r = await callCliPassthrough(
      mkConfig({ deny_subcommands: ['delete'] }),
      'run',
      { args: ['delete', 'x'] },
      ['echo'],
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('deny_subcommands');
  });

  it('honors policy.allow_subcommands', async () => {
    const r = await callCliPassthrough(
      mkConfig({
        policy: {
          allow_subcommands: ['hello'],
          max_args: 256,
          on_violation: 'deny' as const,
          audit: false,
        },
      }),
      'run',
      { args: ['goodbye'] },
      ['echo'],
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('allow_subcommands');
  });

  it('honors policy.deny_args_regex', async () => {
    const r = await callCliPassthrough(
      mkConfig({
        policy: {
          deny_args_regex: ['^--token='],
          max_args: 256,
          on_violation: 'deny' as const,
          audit: false,
        },
      }),
      'run',
      { args: ['hi', '--token=secret'] },
      ['echo'],
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('deny_args_regex');
  });

  it('returns a clean error for invalid policy regex (caught at first use)', async () => {
    const r = await callCliPassthrough(
      mkConfig({
        policy: {
          deny_args_regex: ['[broken'],
          max_args: 256,
          on_violation: 'deny' as const,
          audit: false,
        },
      }),
      'run',
      { args: ['hi'] },
      ['echo'],
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Policy');
    expect(r.content[0].text).toContain('invalid');
  });

  it('rejects help input that could swallow the appended help flag', async () => {
    for (const subcommand of ['repo delete x --repo', 'repo delete x --', 'repo --help=false']) {
      const r = await callCliPassthrough(mkConfig(), 'help', { subcommand }, ['echo']);
      expect(r.isError).toBe(true);
    }
  });

  it('still runs __help even when policy is restrictive', async () => {
    const r = await callCliPassthrough(
      mkConfig({
        policy: {
          allow_subcommands: ['nothing'],
          max_args: 256,
          on_violation: 'deny' as const,
          audit: false,
        },
      }),
      'help',
      { subcommand: '' },
      ['echo'],
    );
    // echo --help returns stdout; either path is OK as long as policy wasn't consulted.
    expect(r.content[0].text).toBeDefined();
  });
});

describe('callCliPassthrough — policy decision metric sink', () => {
  it('reports allow and deny with rule category only', async () => {
    const { configurePassthrough } = await import('../../../src/services/tools/adapters/cli/passthrough.js');
    const { runWithCaller } = await import('../../../src/common/request/context.js');
    const seen: unknown[] = [];
    configurePassthrough({policyDecisionSink: e => seen.push(e)});
    const cfg = mkConfig({ policy: { deny_subcommands: ['bad'], max_args: 32, on_violation: 'deny', audit: false } });
    await runWithCaller({ profile: 'p1', tokenId: 't1', authenticated: true }, async () => {
      await callCliPassthrough(cfg, 'run', { args: ['ok'] }, ['echo']);
      await callCliPassthrough(cfg, 'run', { args: ['bad', 'secret-value'] }, ['echo']);
    });
    configurePassthrough({});
    expect(seen).toEqual([
      { tool: 'echo_pass', profile: 'p1', decision: 'allow', rule: 'none' },
      { tool: 'echo_pass', profile: 'p1', decision: 'deny', rule: 'deny_subcommands' },
    ]);
  });
});

describe('callCliPassthrough — canonical argv (T7)', () => {
  it('refuses an ill-formed (lone surrogate) argv without echoing it', async () => {
    const r = await callCliPassthrough(mkConfig(), 'run', { args: ['ok', 'sekret\uD800'] }, ['echo']);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('ill_formed at position 1');
    expect(r.content[0].text).not.toContain('sekret');
  });

  it('keeps the legacy messages for non-array / non-string / NUL argv', async () => {
    const t = async (args: unknown) =>
      (await callCliPassthrough(mkConfig(), 'run', { args }, ['echo'])).content[0].text;
    expect(await t('x')).toContain("'args' must be an array of strings");
    expect(await t(['a', 1])).toContain("all items in 'args' must be strings");
    expect(await t(['a\u0000'])).toContain('NUL');
  });
});


describe('CLI configuration isolation', () => {
  it('gh uses an empty temporary HOME/config and removes it after execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'splicedock-test-'));
    const command = join(dir, 'gh');
    try {
      writeFileSync(command, '#!/bin/sh\nprintf "%s" "$GH_CONFIG_DIR"\n', { mode: 0o700 });
      const result = await callCliPassthrough(mkConfig({ command }), 'run', { args: ['version'] }, [command]);
      expect(result.isError).toBe(false);
      const configDir = result.content[0].text;
      expect(configDir).toContain('splicedock-tool-');
      expect(configDir).not.toBe(process.env['HOME']);
      expect(existsSync(configDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
