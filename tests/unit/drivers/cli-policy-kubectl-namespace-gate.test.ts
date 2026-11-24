// kubectl effective-namespace gate (Codex release review of bb03af5, HIGH 1 + 2).
//
// A confined kubectl policy (a namespace anywhere in require_args or
// require_any_of) allows exactly the namespaces named in those requirements.
// The raw argv is scanned with kubectl's built-in arity table, never the
// operator's value_flags / boolean_flags. At least one namespace occurrence is
// required and every occurrence must be allowed. If the operator table reads
// the namespace differently from kubectl's table, the call is refused.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { compilePolicy, evaluatePolicy, type PolicyDecision } from '../../../src/services/policy/cli/rules.js';
import { kubectlNamespaceValues } from '../../../src/services/policy/cli/kubectl/confinement.js';
import { callCliPassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig, CliToolPolicy } from '../../../src/config/types.js';

type Extra = {
  require_args?: string[];
  require_any_of?: string[][];
  value_flags?: string[];
  boolean_flags?: string[];
};
const kube = (extra: Extra) =>
  compilePolicy({ max_args: 256, audit: false, on_violation: 'deny', ...extra }, { command: 'kubectl' });
const confined = (extra: Extra = {}) => kube({ require_args: ['--namespace=isolated'], ...extra });
const MIXED: Extra = { require_any_of: [['--namespace=isolated', '--selector=app=x']] };
const denied = (d: PolicyDecision): boolean => d.ok === false;

const ALLOWED_SPELLINGS: readonly (readonly string[])[] = [
  ['-n', 'isolated'],
  ['-nisolated'],
  ['-n=isolated'],
  ['--namespace', 'isolated'],
  ['--namespace=isolated'],
  ['-wn', 'isolated'],
  ['-wnisolated'],
  ['-wn=isolated'],
];
const FOREIGN_SPELLINGS: readonly (readonly string[])[] = [
  ['-n', 'other'],
  ['-nother'],
  ['-n=other'],
  ['--namespace', 'other'],
  ['--namespace=other'],
  ['-wn', 'other'],
  ['-wnother'],
  ['-wn=other'],
];

describe('kubectlNamespaceValues scanner (built-in table)', () => {
  it.each([
    [['get', 'pods', '-n', 'a'], ['a']],
    [['-na'], ['a']],
    [['-n=a'], ['a']],
    [['--namespace', 'a'], ['a']],
    [['--namespace=a'], ['a']],
    [['-wn', 'a'], ['a']],
    [['-wna'], ['a']],
    [['-wn=a'], ['a']],
    [['-n', 'a', '--namespace=b'], ['a', 'b']],
    [['-on'], []],
    [['-o', '-n', 'x'], []],
    [['-l', '-n', 'x'], []],
    [['--selector', '--namespace=x'], []],
    [['-w=n'], []],
    [['--', '-n', 'x'], []],
    [['exec', 'pod', '-n', 'a', '--', '-n', 'b'], ['a']],
    [['-l', '--', '-n', 'b'], ['b']],
    [['--unknown', 'val', '-n', 'a'], ['a']],
    [['--unknown=v', '-n', 'a'], ['a']],
    [['get', 'pods'], []],
  ] as const)('%j → %j', (argv, want) => {
    expect(kubectlNamespaceValues(argv)).toEqual(want);
  });
  it.each([
    [['-n']],
    [['--namespace']],
    [['get', '-wn']],
    [['--unknown', '-n', 'a']],
    [['--unknown', '--', '-n', 'b']],
    [['-xn', 'a']],
    [['-xna']],
  ] as const)('%j is ambiguous (null)', argv => {
    expect(kubectlNamespaceValues(argv)).toBeNull();
  });
});

describe('HIGH 1: a mixed require_any_of cannot widen the namespace', () => {
  it('Codex repro: the selector alternative with another namespace is denied', () => {
    const d = evaluatePolicy(['get', 'pods', '--selector=app=x', '--namespace=other'], kube(MIXED));
    expect(d).toMatchObject({ ok: false, rule: 'require_any_of' });
  });
  it('the selector alone (kubeconfig default namespace) is denied', () => {
    expect(denied(evaluatePolicy(['get', 'pods', '--selector=app=x'], kube(MIXED)))).toBe(true);
  });
  it('the allowed namespace still satisfies the group, with or without the selector', () => {
    expect(evaluatePolicy(['get', 'pods', '--namespace=isolated'], kube(MIXED))).toEqual({ ok: true });
    expect(evaluatePolicy(['get', 'pods', '--selector=app=x', '-n', 'isolated'], kube(MIXED))).toEqual({ ok: true });
  });
});

describe('HIGH 2: operator arity overrides cannot hide a namespace swap', () => {
  it('Codex repro: value_flags --watch swallowing -n is denied', () => {
    const p = confined({ value_flags: ['--watch'] });
    expect(denied(evaluatePolicy(['get', 'pods', '--namespace=isolated', '--watch', '-n', 'other'], p))).toBe(true);
  });
  it('value_flags --save-config swallowing -n is denied', () => {
    const p = confined({ value_flags: ['--save-config'] });
    const argv = ['create', 'deployment', 'x', '--image=nginx', '-n', 'isolated', '--save-config', '-n', 'other'];
    expect(denied(evaluatePolicy(argv, p))).toBe(true);
  });
  it.each([
    [{ value_flags: ['-w'] }, ['get', 'pods', '-n', 'isolated', '-w', '-n', 'other']],
    [{ value_flags: ['-w'] }, ['get', 'pods', '-n', 'isolated', '-wn', 'other']],
    [{ value_flags: ['--show-labels'] }, ['get', 'pods', '-n', 'isolated', '--show-labels', '--namespace=other']],
    [{ value_flags: ['--all'] }, ['delete', 'pods', '-n', 'isolated', '--all', '-nother']],
    [{ boolean_flags: ['--selector'] }, ['get', 'pods', '-n', 'isolated', '--selector', '--namespace=isolated']],
    [{ boolean_flags: ['-l'] }, ['get', 'pods', '-n', 'isolated', '-l', '-n', 'isolated']],
  ] as const)('override %j with %j is denied', (extra, argv) => {
    expect(denied(evaluatePolicy(argv, confined(extra)))).toBe(true);
  });
  it('an override that reads the namespace the same way as kubectl is harmless', () => {
    expect(evaluatePolicy(['get', 'pods', '-n', 'isolated', '--watch'], confined({ value_flags: ['--watch'] }))).toEqual({ ok: true });
  });
  it('an override that hides the only namespace is denied (tables disagree)', () => {
    const p = confined({ value_flags: ['--watch'] });
    expect(denied(evaluatePolicy(['get', 'pods', '--watch', '-n', 'isolated'], p))).toBe(true);
  });
});

describe('every namespace occurrence must be allowed', () => {
  it('a missing namespace is denied', () => {
    const d = evaluatePolicy(['get', 'pods'], confined());
    expect(d).toMatchObject({ ok: false, rule: 'require_args' });
  });
  it.each(ALLOWED_SPELLINGS)('allowed spelling %j passes', (...spelling) => {
    expect(evaluatePolicy(['get', 'pods', ...spelling], confined())).toEqual({ ok: true });
  });
  it.each(FOREIGN_SPELLINGS)('foreign spelling %j alone is denied', (...spelling) => {
    expect(denied(evaluatePolicy(['get', 'pods', ...spelling], confined()))).toBe(true);
  });
  it.each(FOREIGN_SPELLINGS)('allowed then foreign %j is denied', (...spelling) => {
    expect(denied(evaluatePolicy(['get', 'pods', '-n', 'isolated', ...spelling], confined()))).toBe(true);
  });
  it.each(FOREIGN_SPELLINGS)('foreign %j then allowed is denied', (...spelling) => {
    expect(denied(evaluatePolicy(['get', 'pods', ...spelling, '--namespace=isolated'], confined()))).toBe(true);
  });
  it.each([
    [['get', 'pods', '-n', 'isolated', '--namespace=isolated']],
    [['get', 'pods', '-nisolated', '-n', 'isolated']],
    [['get', 'pods', '--namespace', 'isolated', '-wn=isolated']],
  ])('a duplicate allowed namespace %j passes', argv => {
    expect(evaluatePolicy(argv, confined())).toEqual({ ok: true });
  });
  it('-n as the last token is denied', () => {
    expect(denied(evaluatePolicy(['get', 'pods', '-n', 'isolated', '-n'], confined()))).toBe(true);
  });
  it('an unknown flag right before a namespace token is denied (ambiguous)', () => {
    expect(denied(evaluatePolicy(['get', 'pods', '-n', 'isolated', '--frobnicate', '-n', 'isolated'], confined()))).toBe(true);
  });
  it('a namespace after a real end of options is not an occurrence', () => {
    expect(evaluatePolicy(['exec', 'pod', '-n', 'isolated', '--', 'kubectl', '-n', 'other'], confined())).toEqual({ ok: true });
  });
  it('with two allowed namespaces, each requirement is checked per value', () => {
    const p = kube({ require_any_of: [['--namespace=a', '--namespace=b']] });
    expect(evaluatePolicy(['get', 'pods', '-n', 'b'], p)).toEqual({ ok: true });
    expect(denied(evaluatePolicy(['get', 'pods', '-n', 'a', '-n', 'b'], p))).toBe(true);
    const q = kube({ require_args: ['--namespace=a'], require_any_of: [['--namespace=b', '--selector=x']] });
    expect(denied(evaluatePolicy(['get', 'pods', '-n', 'b', '--selector=x'], q))).toBe(true);
  });
  it('denials never echo the namespace given', () => {
    const d = evaluatePolicy(['get', 'pods', '-n', 'isolated', '-n', 's3cr3t-ns'], confined());
    expect(d.ok).toBe(false);
    expect(JSON.stringify(d)).not.toContain('s3cr3t');
  });
});

describe('compile-time checks for confined kubectl policies', () => {
  it.each([
    [{ value_flags: ['--namespace'] }],
    [{ value_flags: ['-n'] }],
    [{ boolean_flags: ['--namespace'] }],
    [{ boolean_flags: ['-n'] }],
  ])('an arity override %j for the namespace flag is rejected', extra => {
    expect(() => confined(extra)).toThrow(/namespace/);
  });
  it.each([['--namespace=Not_A_Namespace'], ['-n=a=b'], ['--namespace=-x']])(
    'a required namespace %s that is not a namespace name is rejected',
    req => {
      expect(() => kube({ require_args: [req] })).toThrow(/namespace/);
    },
  );
});

// End to end through callCliPassthrough with a fake kubectl: the gate is live
// on the enforcement path, and kubectl never runs.
describe('callCliPassthrough enforces the namespace gate before spawning', () => {
  const run = async (policy: Extra, args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'kube-ns-gate-'));
    const marker = join(dir, 'ran');
    const cmd = join(dir, 'kubectl');
    writeFileSync(cmd, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const config = {
      type: 'cli_passthrough', name: 'kube_ns_gate', description: 'confined kubectl', command: cmd,
      deny_subcommands: [], env: [], timeout_ms: 5000, isolate_config: false,
      policy: { max_args: 64, on_violation: 'deny', audit: false, ...policy } as CliToolPolicy,
    } as CliPassthroughToolConfig;
    try {
      const r = await callCliPassthrough(config, 'run', { args }, [cmd]);
      return { isError: r.isError === true, ran: existsSync(marker), text: r.content[0]?.text };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it('HIGH 1 repro is refused and kubectl never runs', async () => {
    expect(await run(MIXED, ['get', 'pods', '--selector=app=x', '--namespace=other'])).toMatchObject({ isError: true, ran: false });
  });
  it('the mixed group with only the selector is refused', async () => {
    expect(await run(MIXED, ['get', 'pods', '--selector=app=x'])).toMatchObject({ isError: true, ran: false });
  });
  it('HIGH 2 repro is refused and kubectl never runs', async () => {
    const policy = { require_args: ['--namespace=isolated'], value_flags: ['--watch'] };
    expect(await run(policy, ['get', 'pods', '--namespace=isolated', '--watch', '-n', 'other'])).toMatchObject({ isError: true, ran: false });
  });
  it('the allowed namespace still runs', async () => {
    const r = await run(MIXED, ['get', 'pods', '--selector=app=x', '-n', 'isolated']);
    expect(r, r.text).toMatchObject({ isError: false, ran: true });
  });
});
