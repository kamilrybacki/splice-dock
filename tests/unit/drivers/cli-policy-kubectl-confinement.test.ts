// kubectl namespace confinement (Codex review of ed84ff5, HIGH).
//
// A kubectl policy that requires a namespace (require_args / require_any_of
// naming --namespace or -n) is a confinement boundary. Any flag that changes
// the effective request target, the identity, the client config, or reads
// manifests that carry their own namespace must be refused, in every spelling,
// independently of the flag-arity table and of operator arity overrides.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { compilePolicy, evaluatePolicy, type PolicyDecision } from '../../../src/services/policy/cli/rules.js';
import { kubectlConfinementBreach } from '../../../src/services/policy/cli/kubectl/confinement.js';
import { callCliPassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig, CliToolPolicy } from '../../../src/config/types.js';

type Extra = {
  require_args?: string[];
  require_any_of?: string[][];
  allow_subcommands?: string[];
  value_flags?: string[];
  boolean_flags?: string[];
};
const kube = (extra: Extra, command = 'kubectl') =>
  compilePolicy({ max_args: 256, audit: false, on_violation: 'deny', ...extra }, { command });
const confined = (extra: Extra = {}) => kube({ require_args: ['--namespace=isolated'], ...extra });
const denied = (d: PolicyDecision): boolean => d.ok === false;

describe('Codex repro: --raw alongside a required namespace', () => {
  it('get with --raw=<URI> into another namespace is denied', () => {
    const p = kube({ allow_subcommands: ['get'], require_args: ['--namespace=isolated'] });
    const d = evaluatePolicy(['get', '--namespace=isolated', '--raw=/api/v1/namespaces/other/pods/item'], p);
    expect(d).toMatchObject({ ok: false, rule: 'require_args', matched: '--namespace=isolated' });
    expect(d.ok === false && d.message).toMatch(/--raw/);
  });
  it('delete with --raw is denied', () => {
    const p = kube({ allow_subcommands: ['delete'], require_args: ['--namespace=isolated'] });
    expect(denied(evaluatePolicy(['delete', '--namespace=isolated', '--raw=/api/v1/namespaces/other/pods/item'], p))).toBe(true);
  });
  it('require_any_of with --raw is denied', () => {
    const p = kube({ allow_subcommands: ['get'], require_any_of: [['--namespace=isolated', '--namespace=other-allowed']] });
    const d = evaluatePolicy(['get', '--namespace=isolated', '--raw=/api/v1/pods'], p);
    expect(d).toMatchObject({ ok: false, rule: 'require_any_of', matched: '--namespace=isolated|--namespace=other-allowed' });
  });
  it('--raw with a separate value is denied', () => {
    expect(denied(evaluatePolicy(['get', '-n', 'isolated', '--raw', '/api/v1/pods'], confined()))).toBe(true);
  });
});

describe('a namespace anywhere in the requirements means confined (mixed groups)', () => {
  const p = kube({ require_any_of: [['--namespace=isolated', '--selector=app=x']] });
  it.each([['-A'], ['--raw=/api/v1/pods'], ['--server=https://elsewhere.invalid']])(
    'a satisfied non-namespace alternative does not unlock %s',
    flag => {
      const d = evaluatePolicy(['get', 'pods', '--namespace=isolated', '--selector=app=x', flag], p);
      expect(d).toMatchObject({ ok: false, rule: 'require_any_of' });
    },
  );
  it('-A alongside only the other alternative is also denied', () => {
    expect(denied(evaluatePolicy(['get', 'pods', '--selector=app=x', '-A'], p))).toBe(true);
  });
});

// Value-taking target / identity / client-config flags (kubectl 1.32.3
// `kubectl options` + `kubectl get --help`; --kuberc is 1.33+).
const VALUE_FLAGS = [
  'raw', 'kubeconfig', 'context', 'cluster', 'server', 'tls-server-name', 'certificate-authority',
  'user', 'username', 'password', 'token', 'as', 'as-group', 'as-uid', 'client-certificate',
  'client-key', 'cache-dir', 'profile', 'profile-output', 'kuberc', 'filename', 'kustomize',
];
const BOOL_FLAGS = ['insecure-skip-tls-verify', 'all-namespaces'];
// Make every flag "known" so the arity pre-check cannot be what refuses it.
const KNOWN = {
  value_flags: ['--username', '--password', '--profile', '--profile-output', '--kuberc'],
  boolean_flags: ['-f'],
};

describe('every target / identity flag is denied in every spelling', () => {
  it.each(VALUE_FLAGS)('--%s=value and --%s value', flag => {
    for (const argv of [
      ['get', 'pods', '-n', 'isolated', `--${flag}=x`],
      ['get', 'pods', '-n', 'isolated', `--${flag}`, 'x'],
      [`--${flag}=x`, 'get', 'pods', '--namespace=isolated'],
    ]) {
      expect(denied(evaluatePolicy(argv, confined())), argv.join(' ')).toBe(true);
      const d = evaluatePolicy(argv, confined(KNOWN));
      expect(d, argv.join(' ')).toMatchObject({ ok: false, rule: 'require_args' });
    }
  });
  it.each(BOOL_FLAGS)('--%s with any value', flag => {
    for (const spelling of [`--${flag}`, `--${flag}=true`, `--${flag}=false`, `--${flag}=0`]) {
      const d = evaluatePolicy(['get', 'pods', '-n', 'isolated', spelling], confined(KNOWN));
      expect(d, spelling).toMatchObject({ ok: false, rule: 'require_args' });
    }
  });
  it.each([
    [['-s', 'https://elsewhere.invalid']], [['-s=https://elsewhere.invalid']], [['-shttps://elsewhere.invalid']],
    [['-A']], [['-wA']], [['-As']], [['-k', 'dir']], [['-kdir']], [['-f', 'm.yaml']], [['-fm.yaml']],
    [['-f', 'https://elsewhere.invalid/m.yaml']], [['--as-group=a', '--as-group=b']],
  ])('short / grouped / repeated spelling %j', extra => {
    expect(denied(evaluatePolicy(['get', 'pods', '-n', 'isolated', ...extra], confined()))).toBe(true);
    expect(denied(evaluatePolicy(['get', 'pods', '-n', 'isolated', ...extra], confined(KNOWN)))).toBe(true);
  });
  // kubectl normalizes '_' to '-' in flag names (WordSepNormalizeFunc; verified
  // against kubectl 1.32.3: `--as_group`, `--all_namespaces` are accepted).
  it.each([
    ['--all_namespaces'], ['--as_group=a'], ['--as_uid=1'], ['--client_key=k'], ['--tls_server_name=h'],
    ['--insecure_skip_tls_verify'], ['--client_certificate', 'c'], ['--certificate_authority=ca'],
  ])('underscore spelling %s is denied', (...extra) => {
    const argv = ['get', 'pods', '-n', 'isolated', ...extra];
    expect(denied(evaluatePolicy(argv, confined())), extra.join(' ')).toBe(true);
    // Even when an operator declares the spelling's arity, the gate refuses it.
    const known = confined({
      value_flags: ['--as_group', '--as_uid', '--client_key', '--tls_server_name', '--client_certificate', '--certificate_authority'],
      boolean_flags: ['--all_namespaces', '--insecure_skip_tls_verify'],
    });
    expect(evaluatePolicy(argv, known), extra.join(' ')).toMatchObject({ ok: false, rule: 'require_args' });
  });
  it('-f is denied even where it means --follow (use --follow)', () => {
    expect(denied(evaluatePolicy(['logs', 'pod', '-n', 'isolated', '-f'], confined(KNOWN)))).toBe(true);
    expect(evaluatePolicy(['logs', 'pod', '-n', 'isolated', '--follow'], confined()).ok).toBe(true);
  });
  it('a value flag that swallows -- does not end option scanning', () => {
    expect(denied(evaluatePolicy(['get', 'pods', '-n', 'isolated', '-l', '--', '--raw=/api/v1/pods'], confined()))).toBe(true);
  });
  it('the config subcommand is denied (it reads and rewrites the kubeconfig)', () => {
    const d = evaluatePolicy(['config', 'use-context', 'other', '--namespace=isolated'], confined());
    expect(d).toMatchObject({ ok: false, rule: 'require_args' });
    expect(d.ok === false && d.message).toMatch(/config/);
  });
});

describe('the namespace itself cannot be swapped', () => {
  it('a requirement spelled -n=isolated confines too', () => {
    const p = kube({ require_args: ['-n=isolated'] });
    expect(denied(evaluatePolicy(['get', '-n', 'isolated', '--raw=/api/v1/pods'], p))).toBe(true);
    expect(evaluatePolicy(['get', 'pods', '-n', 'isolated'], p).ok).toBe(true);
  });
  // pflag keeps the last value of a repeated flag.
  it.each([
    [['get', 'pods', '--namespace=isolated', '-n', 'other']],
    [['get', 'pods', '-n', 'isolated', '--namespace=other']],
    [['get', 'pods', '-n', 'isolated', '-nother']],
  ])('a later namespace %j is denied', argv => {
    expect(denied(evaluatePolicy(argv, confined()))).toBe(true);
  });
});

// End to end through callCliPassthrough: the gate is live on the enforcement
// path (policy compiled with the configured command), and the tool never runs.
describe('callCliPassthrough enforces confinement before spawning', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'kube-confine-'));
    const marker = join(dir, 'ran');
    const cmd = join(dir, 'kubectl');
    writeFileSync(cmd, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const config = {
      type: 'cli_passthrough', name: 'kube_confined', description: 'confined kubectl', command: cmd,
      deny_subcommands: [], env: [], timeout_ms: 5000, isolate_config: false,
      policy: { max_args: 64, on_violation: 'deny', audit: false, require_args: ['--namespace=isolated'] } as CliToolPolicy,
    } as CliPassthroughToolConfig;
    return { dir, marker, cmd, config };
  };
  it('--raw next to the required namespace is refused and kubectl never runs', async () => {
    const { dir, marker, cmd, config } = setup();
    try {
      const r = await callCliPassthrough(config, 'run', { args: ['get', '-n', 'isolated', '--raw=/api/v1/pods'] }, [cmd]);
      expect(r.isError).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('the confined call itself still runs', async () => {
    const { dir, marker, cmd, config } = setup();
    try {
      const r = await callCliPassthrough(config, 'run', { args: ['get', 'pods', '-n', 'isolated'] }, [cmd]);
      expect(r.isError, r.content[0]?.text).toBeFalsy();
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('denial messages never echo flag values', () => {
  it.each([[['--token=s3cr3t']], [['--token', 's3cr3t']], [['--client-key=/s3cr3t/key']], [['--raw=/api/s3cr3t']]])(
    '%j',
    extra => {
      const d = evaluatePolicy(['get', 'pods', '-n', 'isolated', ...extra], confined(KNOWN));
      expect(d.ok).toBe(false);
      expect(JSON.stringify(d)).not.toContain('s3cr3t');
    },
  );
});

describe('the boundary is not over-broad', () => {
  it.each([
    [['get', 'pods', '--namespace=isolated']],
    [['get', 'pods', '-n', 'isolated', '-o', 'json']],
    [['get', 'pods', '-n', 'isolated', '-l', 'app=x', '-w']],
    [['logs', 'pod', '-n', 'isolated', '--follow', '--tail=10']],
    [['exec', 'pod', '--namespace=isolated', '--', 'sh', '-c', 'echo']],
    [['exec', 'pod', '--namespace=isolated', '--', 'env', '--raw', '--server=x', '-A', '-f']],
  ])('confined %j stays allowed', argv => {
    expect(evaluatePolicy(argv, confined())).toEqual({ ok: true });
  });
  it('a kubectl policy without a namespace requirement keeps --raw', () => {
    expect(evaluatePolicy(['get', '--raw=/api/v1/pods'], kube({ allow_subcommands: ['get'] })).ok).toBe(true);
    expect(evaluatePolicy(['get', '--raw=/api/v1/pods'], kube({ require_args: ['--output=json'] })).ok).toBe(false);
    expect(evaluatePolicy(['get', '--raw=/api/v1/pods', '--output=json'], kube({ require_args: ['--output=json'] })).ok).toBe(true);
  });
  it('a non-kubectl tool with a --namespace requirement is unaffected', () => {
    const p = kube({ require_args: ['--namespace=x'], value_flags: ['--raw', '--namespace'] }, 'helm');
    expect(evaluatePolicy(['list', '--namespace=x', '--raw=/y'], p).ok).toBe(true);
  });
  it('a kubectl path command (/usr/local/bin/kubectl) is confined too', () => {
    const p = kube({ require_args: ['--namespace=isolated'] }, '/usr/local/bin/kubectl');
    expect(denied(evaluatePolicy(['get', '-n', 'isolated', '--raw=/api'], p))).toBe(true);
  });
});

describe('kubectlConfinementBreach scanner', () => {
  it.each([
    [['-nkube-system'], undefined],
    [['-ojsonpath={.Spec}'], undefined],
    [['-wA'], '--all-namespaces'],
    [['-sx'], '--server'],
    [['-l', '--', '--raw=x'], '--raw'],
    [['--', '--raw=x'], undefined],
    [['pod', '--', '--raw=x'], undefined],
    [['--selector=a', '--', '--raw=x'], undefined],
    [['--follow', '--', '--raw=x'], undefined],
    [['--unknown', '--', '--raw=x'], '--raw'],
    [['-f'], '-f'],
    [['--token', 'x'], '--token'],
    [['--as_group=x'], '--as-group'],
    [['--all_namespaces'], '--all-namespaces'],
  ] as const)('%j → %s', (argv, want) => {
    expect(kubectlConfinementBreach(argv)?.flag).toBe(want);
  });
});
