import { describe, expect, it, vi } from 'vitest';

import { compilePolicy, evaluatePolicy } from '../../../src/services/policy/cli/rules.js';
import type { CliToolPolicy } from '../../../src/config/types.js';

// D14a: `gh api` issues raw HTTP requests and bypasses subcommand
// classification, so it is denied for every gh policy and approval cannot
// override it. There is no kill switch.

const BASE = { max_args: 256, on_violation: 'deny', audit: false } as const;

async function expectHardDeny(argv: string[], p: CliToolPolicy | undefined, command = 'gh'): Promise<void> {
  const fn = vi.fn(() => ({ approved: true as const, id: 'approved-row' }));
  const d = await evaluatePolicy(argv, compilePolicy(p, { command }), { tool: 'gh', fn });
  expect(d.ok).toBe(false);
  if (!d.ok) expect(['hard_deny', 'ambiguous_argv']).toContain(d.rule);
  expect(fn).not.toHaveBeenCalled();
}

describe('gh api hard deny', () => {
  it('applies to the permissive default (no policy)', async () => {
    await expectHardDeny(['api', 'repos/o/r'], undefined);
    await expectHardDeny(['api', '-X', 'DELETE', 'repos/o/r'], undefined, '/usr/local/bin/gh');
  });

  it('sees through global flags before the subcommand', async () => {
    await expectHardDeny(['-R', 'o/r', 'api', 'x'], undefined);
    await expectHardDeny(['--repo=o/r', 'api', 'x'], undefined);
    await expectHardDeny(['--', 'api', 'x'], undefined);
  });

  it('cannot be re-enabled by allow or approval rules (runtime override)', async () => {
    await expectHardDeny(['api', 'x'], { ...BASE, allow_subcommands: ['api'] } as CliToolPolicy);
    await expectHardDeny(['api', 'x'], {
            ...BASE,
            on_violation: 'approval',
            approval_subcommands: ['api'],
          } as CliToolPolicy);
    await expectHardDeny(['api', 'x'], {
            ...BASE,
            on_violation: 'approval',
            approval_subcommand_paths: [['api']],
          } as CliToolPolicy);
  });

  it('does not affect other tools or other gh subcommands', () => {
    expect(evaluatePolicy(['api', 'x'], compilePolicy(undefined, { command: 'sometool' })).ok).toBe(true);
    expect(evaluatePolicy(['pr', 'list'], compilePolicy(undefined, { command: 'gh' })).ok).toBe(true);
  });

  it('does not echo argv in the denial message', () => {
    const d = evaluatePolicy(['api', 'repos/secret-owner-xyz'], compilePolicy(undefined, { command: 'gh' }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.message).not.toContain('secret-owner-xyz');
  });
});
