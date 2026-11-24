// R4: the wrapper resolves the effective cwd (realpath) BEFORE the policy
// check, binds the approval to it, and spawns in exactly that directory.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callCliPassthrough, setApprovalHookFactory, setApprovalSettler } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig, CliToolPolicy } from '../../../src/config/types.js';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { ApprovalService } from '../../../src/services/approvals/base.js';
import { runWithCaller } from '../../../src/common/request-context.js';

const CALLER = { profile: 'p', tokenId: 'tok-a', authenticated: true };

const cfg: CliPassthroughToolConfig = {
  type: 'cli_passthrough',
  name: 'pwd_approval',
  description: 'env pwd for tests: prints the physical cwd of the child',
  command: 'env',
  deny_subcommands: [],
  env: [],
  timeout_ms: 5000,
  policy: { max_args: 8, on_violation: 'approval', approval_subcommands: ['pwd'], audit: false } as CliToolPolicy,
};

describe('approval cwd binding through the wrapper', () => {
  let svc: ApprovalService;
  let root: string;
  let dirA: string;
  let dirB: string;
  let linkA: string;

  beforeEach(async () => {
    svc = new ApprovalService({ store: await SplicedockStore.open(':memory:'), sweepIntervalMs: 0 });
    setApprovalHookFactory((tool, ctx) => svc.makeHook(tool, ctx.cwd));
    setApprovalSettler(svc);
    root = realpathSync(mkdtempSync(join(tmpdir(), 'splicedock-r4-')));
    dirA = join(root, 'a');
    dirB = join(root, 'b');
    mkdirSync(dirA);
    mkdirSync(dirB);
    linkA = join(root, 'link-to-a');
    symlinkSync(dirA, linkA);
  });

  afterEach(() => {
    setApprovalHookFactory(null);
    setApprovalSettler(null);
  });

  const run = (cwd?: string) =>
    runWithCaller(CALLER, () => callCliPassthrough(cfg, 'run', cwd === undefined ? { args: ['pwd'] } : { args: ['pwd'], cwd }, ['env']));

  const approveOnlyPending = async (): Promise<string> => {
    const pending = await svc.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(await svc.approve(pending[0]!.id, 'op')).toBe(true);
    return pending[0]!.id;
  };

  it('binds to the realpath of a symlinked cwd and spawns there', async () => {
    const first = await run(linkA);
    expect(first.isError).toBe(true);
    expect(first.content[0]!.text).toContain('Approval required');
    expect((await svc.list({ status: 'pending' }))[0]!.cwd).toBe(dirA);
    const id = await approveOnlyPending();

    // Same directory through its real path: same binding.
    const ran = await run(dirA);
    expect(ran.isError).toBeFalsy();
    expect(ran.content[0]!.text.trim()).toBe(dirA);
    expect((await svc.get(id))?.status).toBe('consumed');
  });

  it('an approval for one cwd does not run in another', async () => {
    await run(dirA);
    const id = await approveOnlyPending();
    const other = await run(dirB);
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toContain('Approval required');
    expect((await svc.get(id))?.status).toBe('approved');
  });

  it('without a cwd the binding is the realpath of the server cwd', async () => {
    await run();
    expect((await svc.list({ status: 'pending' }))[0]!.cwd).toBe(realpathSync(process.cwd()));
    await approveOnlyPending();
    const ran = await run();
    expect(ran.isError).toBeFalsy();
    expect(ran.content[0]!.text.trim()).toBe(realpathSync(process.cwd()));
  });
});
