// R3: approval is evaluated strictly last. A bound, operator-approved row for
// the exact argv must never override a deny or require rule that also matches:
// the call is refused, the row stays 'approved' (not reserved, not consumed)
// and nothing is spawned. Exercised end to end through the real store,
// ApprovalService and wrapper.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callCliPassthrough, configurePassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig, CliToolPolicy } from '../../../src/config/types.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';
import { runWithCaller } from '../../../src/common/request/context.js';

const TOOL = 'precedence_tool';
const CALLER = { profile: 'p', tokenId: 'tok-a', authenticated: true };
const BASE = { max_args: 8, on_violation: 'approval', audit: false } as const;

describe('bound approval vs narrower deny/require rules', () => {
  let svc: ApprovalService;
  let root: string;
  let work: string;
  let marker: string;
  let script: string;

  beforeEach(async () => {
    svc = new ApprovalService({ store: await SplicedockStore.open(':memory:'), sweepIntervalMs: 0 });
    configurePassthrough({approvalHookFactory: (tool, ctx) => svc.makeHook(tool, ctx.cwd), approvalSettler: svc});
    root = realpathSync(mkdtempSync(join(tmpdir(), 'splicedock-r3-')));
    work = join(root, 'work');
    mkdirSync(work);
    marker = join(root, 'spawned');
    script = join(root, 'fake-cli');
    writeFileSync(script, `#!/bin/sh\n: > '${marker}'\n`);
    chmodSync(script, 0o755);
  });

  afterEach(() => {
    configurePassthrough({});
    rmSync(root, { recursive: true, force: true });
  });

  const cfg = (policy: Partial<CliToolPolicy>): CliPassthroughToolConfig => ({
    type: 'cli_passthrough',
    name: TOOL,
    description: 'approval precedence tests',
    command: script,
    deny_subcommands: [],
    env: [],
    timeout_ms: 5000,
    policy: { ...BASE, ...policy } as CliToolPolicy,
  });

  const run = (policy: Partial<CliToolPolicy>, args: string[]) =>
    runWithCaller(CALLER, () => callCliPassthrough(cfg(policy), 'run', { args, cwd: work }, [script]));

  /** Create and approve a row bound to CALLER for exactly this argv + cwd,
   *  bypassing the evaluator (as if a broader rule had requested it). */
  const preApprove = async (argv: string[]): Promise<string> => {
    const v = await svc.makeHook(TOOL, work, CALLER)({ argv, rule: 'approval_subcommands', matched: argv[0]! });
    if (v.approved || !('id' in v)) throw new Error('expected a pending row');
    expect(await svc.approve(v.id, 'op')).toBe(true);
    return v.id;
  };

  const expectRefused = async (policy: Partial<CliToolPolicy>, argv: string[], rule: RegExp) => {
    const id = await preApprove(argv);
    const res = await run(policy, argv);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(rule);
    expect((await svc.get(id))?.status).toBe('approved');
    expect(existsSync(marker)).toBe(false);
  };

  it('deny_args beats an approved row', async () => {
    await expectRefused(
      { approval_subcommands: ['delete'], deny_args: ['--force'] },
      ['delete', 'x', '--force'],
      /deny_args|denied substring/,
    );
  });

  it('deny_argv_regex beats an approved row', async () => {
    await expectRefused(
      { approval_subcommands: ['delete'], deny_argv_regex: ['delete .*prod'] },
      ['delete', 'prod-x'],
      /deny_argv_regex|denied pattern/,
    );
  });

  it('a narrower deny_subcommand_paths beats an approved broader subcommand', async () => {
    await expectRefused(
      { approval_subcommands: ['delete'], deny_subcommand_paths: [['delete', 'all']] },
      ['delete', 'all'],
      /deny_subcommand_paths/,
    );
  });

  it('an approval path shadowed by deny_subcommands fails closed (policy does not compile)', async () => {
    await expectRefused(
      { approval_subcommand_paths: [['delete', 'x']], deny_subcommands: ['delete'] },
      ['delete', 'x'],
      /unreachable.*deny_subcommands|deny_subcommands/,
    );
  });

  it('require_args failure beats an approved row', async () => {
    await expectRefused(
      { approval_subcommands: ['delete'], require_args: ['--dry-run'] },
      ['delete', 'x'],
      /require_args|required argv element/,
    );
  });

  it('require_any_of failure beats an approved row', async () => {
    await expectRefused(
      { approval_subcommands: ['delete'], require_any_of: [['--dry-run', '--plan']] },
      ['delete', 'x'],
      /require_any_of|at least one of/,
    );
  });

  it('control: the same approved row is consumed when no other rule matches', async () => {
    const argv = ['delete', 'x', '--dry-run=server'];
    const id = await preApprove(argv);
    const res = await run({ approval_subcommands: ['delete'], require_args: ['--dry-run=server'] }, argv);
    expect(res.isError).toBeFalsy();
    expect(existsSync(marker)).toBe(true);
    expect((await svc.get(id))?.status).toBe('consumed');
  });
});
