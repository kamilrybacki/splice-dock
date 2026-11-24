// R6: the wrapper validates spawn inputs BEFORE the approval hook runs, so an
// unspawnable command never touches an approval. Once the hook has reserved a
// row, the row is finalized when the child spawns (whatever its exit code or
// a timeout) and released only when the spawn itself fails.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callCliPassthrough, configurePassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig, CliToolPolicy } from '../../../src/config/types.js';
import type { ToolHooks } from '../../../src/services/tools/hooks.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';
import { runWithCaller } from '../../../src/common/request/context.js';

const CALLER = { profile: 'p', tokenId: 'tok-a', authenticated: true };
const POLICY = {
  max_args: 8,
  on_violation: 'approval',
  approval_subcommands: ['pwd', 'false', 'sleep'],
  audit: false,
} as CliToolPolicy;

const cfgFor = (command: string, timeout_ms = 5000): CliPassthroughToolConfig => ({
  type: 'cli_passthrough',
  name: 'reservation_tool',
  description: 'approval reservation tests',
  command,
  deny_subcommands: [],
  env: [],
  timeout_ms,
  policy: POLICY,
});

describe('approval reservation through the wrapper', () => {
  let svc: ApprovalService;
  let root: string;
  let work: string;
  let baseHooks: ToolHooks;

  beforeEach(async () => {
    svc = new ApprovalService({ store: await SplicedockStore.open(':memory:'), sweepIntervalMs: 0 });
    baseHooks = { approvalHookFactory: (tool, ctx) => svc.makeHook(tool, ctx.cwd), approvalSettler: svc };
    configurePassthrough(baseHooks);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'splicedock-r6-')));
    work = join(root, 'work');
    mkdirSync(work);
  });

  afterEach(() => {
    configurePassthrough({});
    rmSync(root, { recursive: true, force: true });
  });

  const run = (command: string, args: string[], timeout_ms?: number) =>
    runWithCaller(CALLER, () => callCliPassthrough(cfgFor(command, timeout_ms), 'run', { args, cwd: work }, [command]));

  /** Create and approve a row for exactly this argv and cwd, bypassing the wrapper. */
  const preApprove = async (argv: string[]): Promise<string> => {
    const v = await svc.makeHook('reservation_tool', work, CALLER)({ argv, rule: 'approval_subcommands', matched: argv[0]! });
    if (v.approved || !('id' in v)) throw new Error('expected a pending row');
    expect(await svc.approve(v.id, 'op')).toBe(true);
    return v.id;
  };

  it('a missing command is refused before the approval is touched', async () => {
    const id = await preApprove(['pwd']);
    const res = await run('splicedock-placeholder-missing-binary', ['pwd']);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not found/i);
    expect((await svc.get(id))?.status).toBe('approved');
  });

  it('a non-executable command path is refused before the approval is touched', async () => {
    const file = join(root, 'not-executable');
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o644);
    const id = await preApprove(['pwd']);
    const res = await run(file, ['pwd']);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not executable/i);
    expect((await svc.get(id))?.status).toBe('approved');
  });

  it('a directory is not accepted as the command', async () => {
    const id = await preApprove(['pwd']);
    const res = await run(root, ['pwd']);
    expect(res.isError).toBe(true);
    expect((await svc.get(id))?.status).toBe('approved');
  });

  it('a NUL byte in args is refused before the approval is touched', async () => {
    const argv = ['pwd', 'a\0b'];
    // T7: a NUL argv is not canonical, so no approval can even be created for it.
    await expect(async () => await preApprove(argv)).rejects.toThrow(/nul/);
    const id = await preApprove(['pwd']);
    const res = await run('env', argv);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/NUL/);
    expect((await svc.get(id))?.status).toBe('approved');
  });

  it('a non-zero exit after the spawn consumes the approval, no refund', async () => {
    const id = await preApprove(['false']);
    const res = await run('env', ['false']);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/^Exit 1/);
    expect((await svc.get(id))?.status).toBe('consumed');
    const again = await run('env', ['false']);
    expect(again.content[0]!.text).toContain('Approval required');
  });

  it('a timeout after the spawn consumes the approval, no refund', async () => {
    const id = await preApprove(['sleep', '5']);
    const res = await run('env', ['sleep', '5'], 200);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/timed out/);
    expect((await svc.get(id))?.status).toBe('consumed');
  });

  it.each([['pwd',true],['false',false]] as const)('settles %s once even if executionResult throws',async (command,success)=>{
    await preApprove([command]);
    const executionResult=vi.fn(()=>{throw new Error('result storage failed');});
    configurePassthrough({...baseHooks, approvalSettler: {finalize:async id=>await svc.finalize(id),release:async id=>await svc.release(id),executionResult}});
    const res=await run('env',[command]);
    expect(executionResult).toHaveBeenCalledTimes(1);
    expect(executionResult).toHaveBeenCalledWith(expect.any(String),success);
    expect(!!res.isError).toBe(!success);
  });
  it('pre-spawn runProcess rejection releases without reporting a grant failure',async ()=>{
    const file=join(root,'bad-interpreter');
    writeFileSync(file,'#!/splicedock-nonexistent-interpreter\n');chmodSync(file,0o755);
    const id=await preApprove(['pwd']);
    const executionResult=vi.fn();
    configurePassthrough({...baseHooks, approvalSettler: {finalize:async id=>await svc.finalize(id),release:async id=>await svc.release(id),executionResult}});
    const res=await run(file,['pwd']);
    expect(res.isError).toBe(true);expect((await svc.get(id))?.status).toBe('approved');
    expect(executionResult).not.toHaveBeenCalled();
  });
  it('a successful run consumes the approval', async () => {
    const id = await preApprove(['pwd']);
    const res = await run('env', ['pwd']);
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text.trim()).toBe(work);
    expect((await svc.get(id))?.status).toBe('consumed');
  });

  it('a spawn that fails before the child starts releases the reservation', async () => {
    const id = await preApprove(['pwd']);
    // Remove the bound cwd after the hook reserved the row but before spawn:
    // chdir fails in the child, so no process ever starts.
    configurePassthrough({...baseHooks, approvalHookFactory: (tool, ctx) => {
      const inner = svc.makeHook(tool, ctx.cwd);
      return async input => {
        const verdict = await inner(input);
        rmSync(work, { recursive: true, force: true });
        return verdict;
      };
    }});
    const res = await run('env', ['pwd']);
    expect(res.isError).toBe(true);
    expect((await svc.get(id))?.status).toBe('approved');
  });
});
