import { afterEach, describe, expect, it } from 'vitest';
import { callCliPassthrough, configurePassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { ToolHooks } from '../../../src/services/tools/hooks.js';
import type { CliPassthroughToolConfig, CliToolPolicy } from '../../../src/config/types.js';
import { runWithCaller } from '../../../src/common/request/context.js';

const SECRET = 'FAKE-SECRET-PLACEHOLDER-1111';

function mkConfig(name: string, policy: Partial<CliToolPolicy> = {}): CliPassthroughToolConfig {
  return {
    type: 'cli_passthrough',
    name,
    description: 'echo for tests',
    command: 'echo',
    deny_subcommands: [],
    env: [],
    timeout_ms: 5000,
    policy: { max_args: 64, on_violation: 'deny', audit: true, ...policy } as CliToolPolicy,
  };
}

const run = (cfg: CliPassthroughToolConfig, args: string[]) =>
  runWithCaller({ profile: 'p', tokenId: 'tok', authenticated: true }, () => callCliPassthrough(cfg, 'run', { args }, ['echo']));

afterEach(() => configurePassthrough({}));

describe('configurePassthrough', () => {
  it('accepts an empty hook set (every field optional)', () => {
    const hooks: ToolHooks = {};
    expect(() => configurePassthrough(hooks)).not.toThrow();
  });

  it('copies the hook object so later mutation of the input has no effect', async () => {
    const calls: unknown[] = [];
    const hooks: { -readonly [K in keyof ToolHooks]: ToolHooks[K] } = { auditSink: e => calls.push(e) };
    configurePassthrough(hooks);
    hooks.auditSink = () => { throw new Error('must not be used'); };
    const r = await run(mkConfig('copy_tool'), ['hi']);
    expect(r.isError).toBeFalsy();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('calls auditSink, metricsSink and policyDecisionSink with no argv content', async () => {
    const audit: Array<Record<string, unknown>> = [];
    const metrics: unknown[] = [];
    const decisions: unknown[] = [];
    configurePassthrough({
      auditSink: e => audit.push({ ...e }),
      metricsSink: e => metrics.push(e),
      policyDecisionSink: e => decisions.push(e),
    });
    const r = await run(mkConfig('sinks_tool'), [SECRET, 'x']);
    expect(r.isError).toBeFalsy();
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]).toMatchObject({ tool: 'sinks_tool', decision: 'allow', argv_len: 2 });
    expect(audit[0]).not.toHaveProperty('argv');
    expect(metrics.length).toBeGreaterThan(0);
    expect(decisions.length).toBeGreaterThan(0);
    for (const e of [...audit, ...metrics, ...decisions]) expect(JSON.stringify(e)).not.toContain(SECRET);
  });

  it('honours an effectivePolicyResolver override that denies', async () => {
    const seen: string[] = [];
    configurePassthrough({
      effectivePolicyResolver: cfg => {
        seen.push(cfg.name);
        return { max_args: 64, on_violation: 'deny', audit: false, deny_args: ['--blocked'] } as CliToolPolicy;
      },
    });
    const cfg = mkConfig('resolver_tool', { audit: false });
    const denied = await run(cfg, ['--blocked']);
    expect(denied.isError).toBe(true);
    expect(seen).toContain('resolver_tool');
    configurePassthrough({});
    const allowed = await run(cfg, ['--blocked']);
    expect(allowed.isError).toBeFalsy();
  });

  it('honours profileEnvResolver', async () => {
    process.env['INJ_TOKEN'] = 'injected-value';
    try {
      configurePassthrough({ profileEnvResolver: (tool, profile) => tool === 'env_tool' && profile === 'p' ? [{ name: 'INJ_VAR', from: 'env:INJ_TOKEN' }] : undefined });
      const cfg = { ...mkConfig('env_tool', { audit: false }), command: 'sh', known_subcommands: 'off', isolate_config: false } as CliPassthroughToolConfig;
      const r = await runWithCaller({ profile: 'p', tokenId: 't', authenticated: true }, () =>
        callCliPassthrough(cfg, 'run', { args: ['-c', 'printf %s "${INJ_VAR:-}"'] }, ['sh']));
      expect(r.content[0]!.text).toBe('injected-value');
    } finally {
      delete process.env['INJ_TOKEN'];
    }
  });

  it('replaces the whole hook set on a second call', async () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    configurePassthrough({ auditSink: e => first.push(e), policyDecisionSink: e => first.push(e) });
    await run(mkConfig('replace_tool'), ['a']);
    const firstCount = first.length;
    expect(firstCount).toBeGreaterThan(0);

    configurePassthrough({ auditSink: e => second.push(e) });
    await run(mkConfig('replace_tool'), ['b']);
    expect(first.length).toBe(firstCount);
    expect(second.length).toBeGreaterThan(0);
  });
});
