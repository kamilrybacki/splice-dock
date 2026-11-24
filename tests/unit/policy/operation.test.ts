import { describe, expect, it, vi } from 'vitest';

import {
  ArgvCanonicalizationError,
  MAX_CANONICAL_ARGS,
  canonicalizeArgv,
  isCanonicalArgv,
  opDigest,
  type CanonicalOperation,
} from '../../../src/services/policy/operation.js';
import { argvHash } from '../../../src/services/approvals/base.js';
import { compilePolicy, evaluatePolicy } from '../../../src/services/policy/cli-policy.js';
import type { CliToolPolicy } from '../../../src/config/types.js';

const LONE_SURROGATE = 'a\uD800b';

describe('canonicalizeArgv', () => {
  it('returns a frozen copy with identical strings', () => {
    const input = ['repo', 'view', 'o/r', 'zażółć', '--json=name'];
    const out = canonicalizeArgv(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(Object.isFrozen(out)).toBe(true);
    expect(isCanonicalArgv(out)).toBe(true);
    expect(isCanonicalArgv(input)).toBe(false);
  });

  it('is idempotent on an already canonical argv', () => {
    const once = canonicalizeArgv(['a', 'b']);
    expect(canonicalizeArgv(once)).toBe(once);
  });

  it.each([
    ['not an array', 'x', 'not_array'],
    ['non-string element', ['a', 1], 'not_string'],
    ['NUL byte', ['a\u0000b'], 'nul'],
    ['lone surrogate', [LONE_SURROGATE], 'ill_formed'],
    ['too many elements', Array.from({ length: MAX_CANONICAL_ARGS + 1 }, () => 'x'), 'too_many'],
  ])('rejects %s', (_label, input, reason) => {
    try {
      canonicalizeArgv(input as unknown);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ArgvCanonicalizationError);
      expect((err as ArgvCanonicalizationError).reason).toBe(reason);
    }
  });

  it('never echoes argv contents in the error message', () => {
    const secret = 'hunter2-SECRET-\u0000';
    try {
      canonicalizeArgv(['--token', secret]);
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
      expect((err as ArgvCanonicalizationError).index).toBe(1);
    }
  });
});

describe('argvHash (backward compatible)', () => {
  it('keeps producing the pinned v2 digests', () => {
    expect(argvHash('gh', '/work/repo', ['repo', 'delete', 'owner/name', '--yes'])).toBe(
      'eaef2ca9e09dd845c41b960402ad014c5c25ca6bebd3835627a689857b3aaf9e',
    );
    expect(argvHash('kubectl', '/', ['get', 'pods', '-n', 'default'])).toBe(
      'c58780486e0784209f07974cc63259bd1cdb3d8c91e75b54fc588cfb98758908',
    );
  });

  it('refuses argv that is not canonicalizable instead of hashing it', () => {
    expect(() => argvHash('gh', '/', [LONE_SURROGATE])).toThrow(ArgvCanonicalizationError);
  });
});

describe('opDigest', () => {
  const op: CanonicalOperation = {
    tool: 'gh',
    argv: canonicalizeArgv(['repo', 'delete', 'o/r']),
    cwd: '/work',
    profile: 'dev',
    tokenId: 'tok-0123456789abcdef',
  };
  const D = (o: CanonicalOperation = op, exp = 1_900_000_000, lvl: 'weak' | 'strong' = 'strong', id = 'apr-1') =>
    opDigest(o, exp, lvl, id);

  it('is a stable hex sha-256', () => {
    expect(D()).toMatch(/^[0-9a-f]{64}$/);
    expect(D()).toBe(D());
  });

  it('changes when any bound field changes', () => {
    const base = D();
    expect(D({ ...op, tool: 'gh2' })).not.toBe(base);
    expect(D({ ...op, argv: canonicalizeArgv(['repo', 'delete', 'o/x']) })).not.toBe(base);
    expect(D({ ...op, cwd: '/other' })).not.toBe(base);
    expect(D({ ...op, profile: 'ops' })).not.toBe(base);
    expect(D({ ...op, tokenId: 'tok-ffffffffffffffff' })).not.toBe(base);
    expect(D(op, 1_900_000_001)).not.toBe(base);
    expect(D(op, undefined, 'weak')).not.toBe(base);
    expect(D(op, undefined, undefined, 'apr-2')).not.toBe(base);
  });

  it('distinguishes cwd null from cwd ""', () => {
    expect(D({ ...op, cwd: null })).not.toBe(D({ ...op, cwd: '' }));
  });

  it('is unambiguous across argv element boundaries', () => {
    const a = D({ ...op, argv: canonicalizeArgv(['ab', 'c']) });
    const b = D({ ...op, argv: canonicalizeArgv(['a', 'bc']) });
    const c = D({ ...op, argv: canonicalizeArgv(['abc']) });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('rejects a non-integer or negative expiresAt', () => {
    expect(() => D(op, 1.5)).toThrow();
    expect(() => D(op, -1)).toThrow();
  });

  it('rejects a non-canonicalizable argv', () => {
    expect(() => D({ ...op, argv: [LONE_SURROGATE] })).toThrow(ArgvCanonicalizationError);
  });
});

describe('contract: one canonical argv for policy, hook, argvHash and opDigest', () => {
  const policy = compilePolicy(
    {
      max_args: 256,
      on_violation: 'approval',
      audit: false,
      approval_subcommand_paths: [['repo', 'delete']],
    } as CliToolPolicy,
    { command: 'gh' },
  );

  it('hands the hook the canonical argv and every consumer agrees on it', async () => {
    const raw = ['repo', 'delete', 'o/r', '--yes'];
    const seen: Array<readonly string[]> = [];
    await evaluatePolicy(raw, policy, {
            tool: 'gh',
            fn: input => {
              seen.push(input.argv);
              return { approved: false, id: 'x', expires_at: 1 };
            },
          });
    expect(seen).toHaveLength(1);
    const hookArgv = seen[0]!;
    expect(isCanonicalArgv(hookArgv)).toBe(true);
    expect(hookArgv).toEqual(raw);
    expect(argvHash('gh', '/w', hookArgv)).toBe(argvHash('gh', '/w', raw));
    const mk = (argv: readonly string[]): CanonicalOperation => ({ tool: 'gh', argv, cwd: '/w', profile: 'p', tokenId: 't' });
    expect(opDigest(mk(hookArgv), 10, 'weak', 'a')).toBe(opDigest(mk(raw), 10, 'weak', 'a'));
  });

  it('every consumer refuses the same non-canonical argv; the hook never runs', async () => {
    const fn = vi.fn();
    const d = await evaluatePolicy(['repo', 'delete', LONE_SURROGATE], policy, { tool: 'gh', fn });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.rule).toBe('invalid_argv');
    expect(fn).not.toHaveBeenCalled();
    expect(() => argvHash('gh', '/w', ['repo', 'delete', LONE_SURROGATE])).toThrow(ArgvCanonicalizationError);
  });
});
