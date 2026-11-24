// R5: raw argv must never reach a sink (stdout logger, audit buffer, metrics,
// policy-decision counter). Only tool, rule id and decision are recorded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callCliPassthrough, configurePassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig, CliToolPolicy } from '../../../src/config/types.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';
import { runWithCaller } from '../../../src/common/request/context.js';

// Obvious placeholder that looks like a credential passed as argv[0].
const SECRET = 'FAKE-SECRET-PLACEHOLDER-0000';

function mkConfig(name: string, policy: Partial<CliToolPolicy>): CliPassthroughToolConfig {
  return {
    type: 'cli_passthrough',
    name,
    description: 'echo for tests',
    command: 'echo',
    deny_subcommands: [],
    env: [],
    timeout_ms: 5000,
    policy: { max_args: 64, on_violation: 'deny', audit: false, ...policy } as CliToolPolicy,
  };
}

describe('no raw argv in any sink', () => {
  let captured: string[];

  beforeEach(() => {
    captured = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    });
    configurePassthrough({auditSink: e => captured.push(JSON.stringify(e)), metricsSink: e => captured.push(JSON.stringify(e)), policyDecisionSink: e => captured.push(JSON.stringify(e))});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    configurePassthrough({});
  });

  const expectNoLeak = (): void => {
    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) expect(line).not.toContain(SECRET);
  };

  it('allow_subcommands deny (matched would be the caller token)', async () => {
    const r = await callCliPassthrough(mkConfig('leak_allow', { allow_subcommands: ['status'] }), 'run', { args: [SECRET] }, ['echo']);
    expect(r.isError).toBe(true);
    expectNoLeak();
    expect(captured.some(l => l.includes('allow_subcommands'))).toBe(true);
  });

  it('allow_subcommand_paths deny', async () => {
    const r = await callCliPassthrough(
      mkConfig('leak_paths', { allow_subcommand_paths: [['status', 'show']] }), 'run', { args: [SECRET, 'x'] }, ['echo'],
    );
    expect(r.isError).toBe(true);
    expectNoLeak();
  });

  it('deny_args deny', async () => {
    const r = await callCliPassthrough(mkConfig('leak_deny', { deny_args: ['--danger'] }), 'run', { args: [SECRET, '--danger'] }, ['echo']);
    expect(r.isError).toBe(true);
    expectNoLeak();
  });

  it('audit accept', async () => {
    const r = await callCliPassthrough(mkConfig('leak_audit', { audit: true }), 'run', { args: [SECRET] }, ['echo']);
    expect(r.isError).toBeFalsy();
    expectNoLeak();
  });

  it('approval pending and approval bypass (consumed)', async () => {
    const store = await SplicedockStore.open(':memory:');
    const svc = new ApprovalService({ store, sweepIntervalMs: 0 });
    configurePassthrough({approvalHookFactory: (name, { cwd }) => svc.makeHook(name, cwd)});
    const cfg = mkConfig('leak_approval', { on_violation: 'approval', approval_subcommands: [SECRET] });
    const caller = { profile: 'p', tokenId: 'tok-a', authenticated: true };

    const pending = await runWithCaller(caller, () => callCliPassthrough(cfg, 'run', { args: [SECRET] }, ['echo']));
    expect(pending.isError).toBe(true);
    const id = (await svc.list({ status: 'pending' }))[0]!.id;
    expect(await svc.approve(id, 'op')).toBe(true);
    const ran = await runWithCaller(caller, () => callCliPassthrough(cfg, 'run', { args: [SECRET] }, ['echo']));
    expect(ran.isError).toBeFalsy();
    expectNoLeak();
    svc.stop();
    await store.close();
  });
});
