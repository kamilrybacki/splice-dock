// B (1c): per-tool known-command tables. Aliases are mapped to canonical
// command names before any path rule runs, and an unknown first subcommand
// (gh extensions, gh config aliases, kubectl-<name> plugins) is refused.
import { describe, expect, it, vi } from 'vitest';

import { compilePolicy, evaluatePolicy, type ApprovalHook, type PolicyDecision } from '../../../src/services/policy/cli/rules.js';
import {
  canonicalizeCommandPath,
  knownCommandsFor,
} from '../../../src/services/policy/cli/commands/known.js';
import type { CliToolPolicy } from '../../../src/config/types.js';
import { cliProfile } from '../../helpers/cli-profiles.js';

const BASE = { max_args: 256, on_violation: 'deny', audit: false } as const;
const mk = (command: string, p?: Partial<CliToolPolicy>, known?: 'enforce' | 'off') =>
  compilePolicy(p ? ({ ...BASE, ...p } as CliToolPolicy) : undefined, {
    profile: cliProfile(command),
    ...(known ? { knownSubcommands: known } : {}),
  });

function rule(d: PolicyDecision): string | undefined {
  return d.ok ? undefined : d.rule;
}

describe('knownCommandsFor / canonicalizeCommandPath', () => {
  it('has tables for gh and kubectl (by basename) and none for other tools', () => {
    expect(knownCommandsFor(cliProfile('gh'))).toBeDefined();
    expect(knownCommandsFor(cliProfile('/usr/local/bin/kubectl'))).toBeDefined();
    expect(knownCommandsFor(cliProfile('codex'))).toBeUndefined();
    expect(knownCommandsFor(cliProfile('ssh'))).toBeUndefined();
    expect(knownCommandsFor(cliProfile(undefined))).toBeUndefined();
  });

  it('maps top-level and nested aliases to canonical names', () => {
    const t = knownCommandsFor(cliProfile('gh'))!;
    expect(canonicalizeCommandPath(['ext', 'uninstall', 'x'], t)).toEqual(['extension', 'remove', 'x']);
    expect(canonicalizeCommandPath(['cs', 'ls'], t)).toEqual(['codespace', 'list']);
    expect(canonicalizeCommandPath(['secret', 'remove'], t)).toEqual(['secret', 'delete']);
    expect(canonicalizeCommandPath(['repo', 'deploy-key', 'ls'], t)).toEqual(['repo', 'deploy-key', 'list']);
    expect(canonicalizeCommandPath([], t)).toEqual([]);
  });

  it('returns null for an unknown first token, including prototype names', () => {
    const t = knownCommandsFor(cliProfile('gh'))!;
    for (const tok of ['myext', 'co', 'constructor', '__proto__', 'toString']) {
      expect(canonicalizeCommandPath([tok], t)).toBeNull();
    }
  });
});

describe('policy with a known-command table (default: enforce)', () => {
  it('refuses an unknown gh subcommand, with and without a policy', () => {
    expect(rule(evaluatePolicy(['myext', 'run'], mk('gh')))).toBe('unknown_subcommand');
    expect(rule(evaluatePolicy(['myext'], mk('gh', { deny_args: ['--x'] })))).toBe('unknown_subcommand');
  });

  it('refuses the config alias `co` (resolved from gh config, not the binary)', () => {
    expect(rule(evaluatePolicy(['co', '12'], mk('gh')))).toBe('unknown_subcommand');
  });

  it('refuses an unknown kubectl subcommand (blocks kubectl-<name> plugin lookup)', () => {
    expect(rule(evaluatePolicy(['foo', 'bar'], mk('kubectl')))).toBe('unknown_subcommand');
    expect(evaluatePolicy(['get', 'pods', '-n', 'default'], mk('kubectl')).ok).toBe(true);
  });

  it('allows a call with no subcommand (e.g. --version)', () => {
    expect(evaluatePolicy(['--version'], mk('gh')).ok).toBe(true);
  });

  it('an alias cannot dodge deny_subcommands', () => {
    const p = mk('gh', { deny_subcommands: ['extension'] });
    expect(rule(evaluatePolicy(['ext', 'install', 'o/x'], p))).toBe('deny_subcommands');
    expect(rule(evaluatePolicy(['extensions', 'install', 'o/x'], p))).toBe('deny_subcommands');
  });

  it('an alias cannot dodge deny_subcommand_paths (headline bypass)', () => {
    const p = mk('gh', { deny_subcommand_paths: [['secret', 'delete'], ['extension', 'remove']] });
    expect(rule(evaluatePolicy(['secret', 'remove', 'NAME'], p))).toBe('deny_subcommand_paths');
    expect(rule(evaluatePolicy(['ext', 'uninstall', 'x'], p))).toBe('deny_subcommand_paths');
    const k = mk('kubectl', { deny_subcommand_paths: [['create', 'serviceaccount']] });
    expect(rule(evaluatePolicy(['create', 'sa', 'x'], k))).toBe('deny_subcommand_paths');
  });

  it('a rule written with an alias still matches the canonical spelling', () => {
    const p = mk('gh', { deny_subcommand_paths: [['secret', 'remove']] });
    expect(rule(evaluatePolicy(['secret', 'delete', 'NAME'], p))).toBe('deny_subcommand_paths');
    const d = mk('gh', { deny_subcommands: ['ext'] });
    expect(rule(evaluatePolicy(['extension', 'list'], d))).toBe('deny_subcommands');
  });

  it('allow lists accept aliases of allowed commands', () => {
    const p = mk('gh', { allow_subcommand_paths: [['pr', 'list']] });
    expect(evaluatePolicy(['pr', 'ls'], p).ok).toBe(true);
    expect(rule(evaluatePolicy(['pr', 'merge', '1'], p))).toBe('allow_subcommand_paths');
  });

  it('approval rules match through aliases; the hook sees the argv as given', async () => {
    const fn = vi.fn<ApprovalHook>(() => ({ approved: false, id: 'a1', expires_at: Date.now() + 1000 }));
    const p = mk('gh', { on_violation: 'approval', approval_subcommand_paths: [['extension', 'remove']] });
    const d = await evaluatePolicy(['ext', 'uninstall', 'x'], p, { tool: 'gh', fn });
    expect(rule(d)).toBe('approval_subcommand_paths');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0].argv).toEqual(['ext', 'uninstall', 'x']);
  });

  it('an approval rule spelled with an alias is unreachable under a canonical deny', () => {
    expect(() =>
      mk('gh', { deny_subcommands: ['extension'], approval_subcommands: ['ext'] }),
    ).toThrow(/unreachable/);
  });

  it('an unknown-arity flag overflow on gh now fails closed (table forces path extraction)', () => {
    const argv: string[] = [];
    for (let i = 0; i < 8; i++) argv.push(`--u${i}`, `v${i}`);
    expect(rule(evaluatePolicy(argv, mk('gh', { deny_args: ['--token'] })))).toBe('ambiguous_argv');
  });

  it('does not echo the unknown token in the message', () => {
    const d = evaluatePolicy(['secret-canary-token'], mk('gh'));
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.message).not.toContain('secret-canary-token');
      expect(d.matched).toBeUndefined();
    }
  });
});

describe('tools without a table and the kill switch', () => {
  it('tools without a table are unchanged', () => {
    expect(evaluatePolicy(['anything', 'goes'], mk('codex')).ok).toBe(true);
    expect(evaluatePolicy(['anything'], mk('echo', { deny_args: ['--x'] })).ok).toBe(true);
  });

  it('known_subcommands: off allows unknown commands but keeps the gh api hard deny', () => {
    expect(evaluatePolicy(['myext'], mk('gh', undefined, 'off')).ok).toBe(true);
    expect(evaluatePolicy(['myext'], mk('gh', { deny_args: ['--x'] }, 'off')).ok).toBe(true);
    expect(rule(evaluatePolicy(['api', '/user'], mk('gh', undefined, 'off')))).toBe('hard_deny');
  });
});
