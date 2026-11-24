// R1: subcommand-path extraction must be tool-aware and fail closed.
//
// Each test is one bypass shape that the old extractor (bare long flag
// swallows the next non-flag token, `--` treated as a long flag, short-flag
// values never consumed) let through.
import { describe, expect, it, vi } from 'vitest';

import {
  compilePolicy,
  evaluatePolicy,
  type ApprovalHook,
  type PolicyDecision,
} from '../../../src/services/policy/cli/rules.js';
import {
  extractSubcommandPaths,
  flagTableFor,
  MAX_PATH_CANDIDATES,
} from '../../../src/services/policy/cli/flags/arity.js';
import type { CliToolPolicy } from '../../../src/config/types.js';

const BASE = { max_args: 256, on_violation: 'deny', audit: false } as const;
const gh = (p: Partial<CliToolPolicy>) => compilePolicy({ ...BASE, ...p } as CliToolPolicy, { command: 'gh' });
const kubectl = (p: Partial<CliToolPolicy>) =>
  compilePolicy({ ...BASE, ...p } as CliToolPolicy, { command: '/usr/local/bin/kubectl' });
const unknownTool = (p: Partial<CliToolPolicy>) =>
  compilePolicy({ ...BASE, ...p } as CliToolPolicy, { command: 'sometool' });

function denied(d: PolicyDecision, rule?: string): void {
  expect(d.ok).toBe(false);
  if (rule && !d.ok) expect(d.rule).toBe(rule);
}

describe('gh-style bypass shapes', () => {
  const repoDelete = { deny_subcommand_paths: [['repo', 'delete']] };

  it('known boolean long flag does not swallow the next subcommand', () => {
    denied(evaluatePolicy(['repo', '--yes', 'delete', 'x'], gh(repoDelete)), 'deny_subcommand_paths');
  });

  it('`--` is the end of flags, not a long flag that swallows a token', () => {
    denied(evaluatePolicy(['repo', '--', 'delete', 'x'], gh(repoDelete)), 'deny_subcommand_paths');
  });

  it('short value flag consumes its value (-R owner/x)', () => {
    denied(evaluatePolicy(['-R', 'owner/x', 'repo', 'delete', 'y'], gh(repoDelete)), 'deny_subcommand_paths');
  });

  it('--flag=value never consumes the next token', () => {
    denied(evaluatePolicy(['--repo=owner/x', 'repo', 'delete'], gh(repoDelete)), 'deny_subcommand_paths');
  });

  it('a value flag consumes `--` as its value (pflag semantics)', () => {
    // `--repo --` → `--` is the value of --repo; `repo delete` is the path.
    denied(evaluatePolicy(['--repo', '--', 'repo', 'delete'], gh(repoDelete)), 'deny_subcommand_paths');
  });

  it('unknown long flag before a denied subcommand is refused', () => {
    // With the gh known-command table (1c B) both readings deny (`delete` is
    // not a gh command), so the refusal may name either rule.
    const d = evaluatePolicy(['--unknown-flag', 'repo', 'delete', 'x'], gh({ deny_subcommands: ['repo'] }));
    denied(d);
    if (!d.ok) expect(['ambiguous_argv', 'unknown_subcommand', 'deny_subcommands']).toContain(d.rule);
  });

  it('unknown flag cannot hide a non-allowed token in front of an allowed one', () => {
    // Old extractor: `--flag` swallowed `secret`, path became [pr] → allowed.
    denied(evaluatePolicy(['--flag', 'secret', 'pr'], gh({ allow_subcommands: ['pr'] })), 'ambiguous_argv');
  });

  it('unknown flag cannot shift an approval-path match', async () => {
    const fn = vi.fn<ApprovalHook>(() => ({ approved: true, id: 'a1' }));
    const p = gh({ approval_subcommand_paths: [['repo', 'delete']] });
    denied(await evaluatePolicy(['repo', '--odd', 'delete', 'x'], p, { tool: 'gh', fn }), 'ambiguous_argv');
    expect(fn).not.toHaveBeenCalled();
  });

  it('too many unknown flags to enumerate fails closed when path rules exist', () => {
    const argv: string[] = [];
    for (let i = 0; i < 8; i++) argv.push(`--u${i}`, `v${i}`);
    argv.push('pr', 'list');
    denied(evaluatePolicy(argv, gh({ allow_subcommands: ['pr'] })), 'ambiguous_argv');
  });

  it('too many unknown flags is fine when no path rule is configured (tool without a table)', () => {
    const argv: string[] = [];
    for (let i = 0; i < 8; i++) argv.push(`--u${i}`, `v${i}`);
    expect(evaluatePolicy(argv, unknownTool({ deny_args: ['--token'] })).ok).toBe(true);
  });

  it('too many unknown flags fails closed on gh (known-command table needs the path)', () => {
    const argv: string[] = [];
    for (let i = 0; i < 8; i++) argv.push(`--u${i}`, `v${i}`);
    denied(evaluatePolicy(argv, gh({ deny_args: ['--token'] })), 'ambiguous_argv');
  });

  it('benign calls are still allowed', () => {
    const p = gh({ allow_subcommands: ['pr', 'issue'] });
    expect(evaluatePolicy(['pr', 'list', '--state', 'open'], p).ok).toBe(true);
    expect(evaluatePolicy(['pr', 'view', '42', '--json', 'title', '--repo', 'o/r'], p).ok).toBe(true);
    // Unknown flag whose interpretations all agree on the verdict is allowed.
    expect(evaluatePolicy(['pr', 'list', '--some-new-flag', 'x'], p).ok).toBe(true);
  });
});

describe('kubectl-style bypass shapes', () => {
  const noDelete = { deny_subcommands: ['delete'] };

  it('-n <ns> before the verb', () => {
    denied(evaluatePolicy(['-n', 'ns', 'delete', 'pod', 'x'], kubectl(noDelete)), 'deny_subcommands');
  });

  it('attached short value -nns and -n=ns', () => {
    denied(evaluatePolicy(['-nns', 'delete', 'pod', 'x'], kubectl(noDelete)), 'deny_subcommands');
    denied(evaluatePolicy(['-n=ns', 'delete', 'pod', 'x'], kubectl(noDelete)), 'deny_subcommands');
  });

  it('long value flag with separate value before the verb', () => {
    denied(evaluatePolicy(['--namespace', 'ns', 'delete', 'pod', 'x'], kubectl(noDelete)), 'deny_subcommands');
    denied(evaluatePolicy(['--context', 'c', 'delete', 'pod', 'x'], kubectl(noDelete)), 'deny_subcommands');
  });

  it('boolean short cluster ending in a value flag (-An ns)', () => {
    denied(evaluatePolicy(['-An', 'ns', 'delete', 'pod'], kubectl(noDelete)), 'deny_subcommands');
  });

  it('allow-list: a namespace value is not mistaken for a subcommand', () => {
    const p = kubectl({ allow_subcommands: ['get', 'describe'] });
    expect(evaluatePolicy(['-n', 'ns', 'get', 'pods'], p).ok).toBe(true);
    denied(evaluatePolicy(['-n', 'get', 'delete', 'pod', 'x'], p), 'allow_subcommands');
  });

  it('deny path after a boolean flag', () => {
    const p = kubectl({ deny_subcommand_paths: [['rollout', 'undo']] });
    denied(evaluatePolicy(['rollout', '--all', 'undo', 'deploy/x'], p), 'deny_subcommand_paths');
  });

  it('ambiguous short flag (not in the table) in front of the verb is refused', () => {
    // Both readings deny once the kubectl table refuses `x` (1c B).
    const d = evaluatePolicy(['-p', 'x', 'delete', 'pod'], kubectl(noDelete));
    denied(d);
    if (!d.ok) expect(['ambiguous_argv', 'unknown_subcommand', 'deny_subcommands']).toContain(d.rule);
  });
});

describe('unknown tools (empty flag table)', () => {
  it('any flag followed by a token is treated as ambiguous for path rules', () => {
    denied(
      evaluatePolicy(['release', '--repo', 'foo', 'delete', 'v1'], unknownTool({ deny_subcommand_paths: [['release', 'delete']] })),
      'ambiguous_argv',
    );
  });

  it('operator-declared value_flags / boolean_flags resolve the ambiguity', () => {
    const p = unknownTool({
      deny_subcommand_paths: [['release', 'delete']],
      value_flags: ['--repo', '-r'],
      boolean_flags: ['--yes'],
    });
    denied(evaluatePolicy(['release', '--repo', 'foo', 'delete', 'v1'], p), 'deny_subcommand_paths');
    denied(evaluatePolicy(['release', '--yes', 'delete', 'v1'], p), 'deny_subcommand_paths');
    denied(evaluatePolicy(['-r', 'foo', 'release', 'delete', 'v1'], p), 'deny_subcommand_paths');
    expect(evaluatePolicy(['release', '--repo', 'foo', 'list'], p).ok).toBe(true);
  });
});

describe('extractSubcommandPaths', () => {
  const ghT = flagTableFor('gh');
  const kT = flagTableFor('kubectl');

  it('returns a single candidate when every flag is known', () => {
    expect(extractSubcommandPaths(['pr', '--state', 'open', 'list'], ghT)).toEqual([['pr', 'list']]);
    expect(extractSubcommandPaths(['-n', 'ns', 'get', 'pods'], kT)).toEqual([['get', 'pods']]);
    expect(extractSubcommandPaths(['get', '-o=yaml', 'pods'], kT)).toEqual([['get', 'pods']]);
  });

  it('keeps everything after `--`, including dash tokens', () => {
    expect(extractSubcommandPaths(['exec', 'p', '--', 'sh', '-c', 'x'], kT)).toEqual([['exec', 'p', 'sh', '-c', 'x']]);
  });

  it('treats a lone `-` as positional', () => {
    expect(extractSubcommandPaths(['apply', '-f', '-'], kT)).toEqual([['apply'], ['apply', '-']]);
    expect(extractSubcommandPaths(['x', '-'], kT)).toEqual([['x', '-']]);
  });

  it('enumerates both readings of an unknown flag', () => {
    const c = extractSubcommandPaths(['--weird', 'a', 'b'], ghT);
    expect(c).toContainEqual(['b']);
    expect(c).toContainEqual(['a', 'b']);
    expect(c).toHaveLength(2);
  });

  it('a trailing unknown flag has nothing to consume', () => {
    expect(extractSubcommandPaths(['a', '--weird'], ghT)).toEqual([['a']]);
  });

  it('returns null above the candidate cap', () => {
    const argv: string[] = [];
    const bits = Math.log2(MAX_PATH_CANDIDATES) + 1;
    for (let i = 0; i < bits; i++) argv.push(`--u${i}`, `v${i}`);
    expect(extractSubcommandPaths(argv, ghT)).toBeNull();
  });
});

describe('flagTableFor', () => {
  it('selects by command basename and falls back to an empty table', () => {
    expect(flagTableFor('/opt/bin/gh').long.get('repo')).toBe('value');
    expect(flagTableFor('kubectl').short.get('n')).toBe('value');
    expect(flagTableFor('other').long.size).toBe(0);
    expect(flagTableFor(undefined).short.size).toBe(0);
  });

  it('overrides win over built-ins', () => {
    const t = flagTableFor('gh', { boolean_flags: ['--repo'], value_flags: ['-z'] });
    expect(t.long.get('repo')).toBe('bool');
    expect(t.short.get('z')).toBe('value');
  });
});

describe('required flags reflect parsed options', () => {
  const p = kubectl({ require_args: ['--namespace=trusted'] });
  it.each([
    ['get', 'pods', '--', '--namespace=trusted'],
    ['get', 'pods', '--context', '--namespace=trusted'],
    ['get', 'pods', '--namespace=trusted', '--namespace=other'],
    ['get', 'pods', '--namespace=trusted', '-n', 'other'],
  ])('rejects ineffective namespace in %j', (...argv) => {
    expect(evaluatePolicy(argv, p).ok).toBe(false);
  });
  it('accepts a separate matching option value', () => {
    expect(evaluatePolicy(['get', 'pods', '--namespace', 'trusted'], p).ok).toBe(true);
  });
});
