import { describe, it, expect, vi } from 'vitest';
import { compilePolicy, evaluatePolicy, type ApprovalHook } from '../../../src/domain/policy/cli-policy.js';

const BASE = { max_args: 256, on_violation: 'deny' as const, audit: false };

function spyHook() {
  const fn = vi.fn().mockReturnValue({ approved: true, id: 'abc' });
  return { fn, hook: { tool: 'gh', fn: fn as unknown as ApprovalHook } };
}

describe('evaluatePolicy: deny always wins, approval last', () => {
  it('approval `repo` + deny path `repo delete` → denied, hook never called', async () => {
    const p = compilePolicy({
      ...BASE,
      approval_subcommands: ['repo'],
      deny_subcommand_paths: [['repo', 'delete']],
    });
    const { fn, hook } = spyHook();
    const r = await evaluatePolicy(['repo', 'delete', 'x'], p, hook);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe('deny_subcommand_paths');
    expect(fn).not.toHaveBeenCalled();
  });

  it('approval path `repo` + deny `repo delete` still approves other `repo` subcommands', async () => {
    const p = compilePolicy({
      ...BASE,
      approval_subcommand_paths: [['repo']],
      deny_subcommand_paths: [['repo', 'delete']],
    });
    const { fn, hook } = spyHook();
    expect((await evaluatePolicy(['repo', 'view'], p, hook)).ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('allow failure + approval match → denied, hook not called', async () => {
    const p = compilePolicy({
      ...BASE,
      allow_subcommands: ['pr'],
      approval_subcommands: ['repo'],
    });
    const { fn, hook } = spyHook();
    const r = await evaluatePolicy(['repo', 'view'], p, hook);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe('allow_subcommands');
    expect(fn).not.toHaveBeenCalled();
  });

  it('require_args failure + approval match → denied, hook not called', async () => {
    const p = compilePolicy({
      ...BASE,
      require_args: ['--namespace=a'],
      approval_subcommand_paths: [['rollout', 'undo']],
    });
    const { fn, hook } = spyHook();
    const r = await evaluatePolicy(['rollout', 'undo', 'deploy/x'], p, hook);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe('require_args');
    expect(fn).not.toHaveBeenCalled();
  });

  it('compile rejects a deny subcommand that overlaps an approval path (approval unreachable)', () => {
    expect(() =>
      compilePolicy({
        ...BASE,
        deny_subcommands: ['rollout'],
        approval_subcommand_paths: [['rollout', 'undo']],
      }),
    ).toThrow(/unreachable/);
  });

  it('compile rejects a deny path equal to or broader than an approval path', () => {
    expect(() =>
      compilePolicy({
        ...BASE,
        deny_subcommand_paths: [['rollout', 'undo']],
        approval_subcommand_paths: [['rollout', 'undo', 'deploy']],
      }),
    ).toThrow(/unreachable/);
    expect(() =>
      compilePolicy({
        ...BASE,
        deny_subcommand_paths: [['rollout']],
        approval_subcommands: ['rollout'],
      }),
    ).toThrow(/unreachable/);
  });

  it('broader approval path + narrower deny path: narrower deny wins, rest of approval reachable', async () => {
    const p = compilePolicy({
      ...BASE,
      approval_subcommand_paths: [['rollout']],
      deny_subcommand_paths: [['rollout', 'undo']],
    });
    const denied = spyHook();
    const r = await evaluatePolicy(['rollout', 'undo', 'deploy/x'], p, denied.hook);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe('deny_subcommand_paths');
    expect(denied.fn).not.toHaveBeenCalled();

    const approved = spyHook();
    const ok = await evaluatePolicy(['rollout', 'status', 'deploy/x'], p, approved.hook);
    expect(ok.ok).toBe(true);
    expect(approved.fn).toHaveBeenCalledTimes(1);
  });

  it('all checks pass + approval match → hook called exactly once', async () => {
    const p = compilePolicy({
      ...BASE,
      allow_subcommands: ['repo'],
      require_args: ['--namespace=a'],
      approval_subcommands: ['repo'],
    });
    const { fn, hook } = spyHook();
    const r = await evaluatePolicy(['repo', '--namespace', 'a'], p, hook);
    expect(r.ok).toBe(true);
    if (r.ok && 'approval' in r) expect(r.approval.reserved_id).toBe('abc');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('non-matching argv never calls the hook', async () => {
    const p = compilePolicy({ ...BASE, approval_subcommands: ['repo'] });
    const { fn, hook } = spyHook();
    expect((await evaluatePolicy(['pr', 'list'], p, hook)).ok).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('compilePolicy: unreachable approval vs deny', () => {
  it('equal within category (subcommands) → error naming both', () => {
    expect(() =>
      compilePolicy({ ...BASE, approval_subcommands: ['undo'], deny_subcommands: ['undo'] }),
    ).toThrow(/approval_subcommands: "undo".*deny_subcommands: "undo"/);
  });

  it('equal within category (paths) → error', () => {
    expect(() =>
      compilePolicy({
        ...BASE,
        approval_subcommand_paths: [['rollout', 'undo']],
        deny_subcommand_paths: [['rollout', 'undo']],
      }),
    ).toThrow(/rollout undo/);
  });

  it('more specific approval path vs shorter deny path → error', () => {
    expect(() =>
      compilePolicy({
        ...BASE,
        approval_subcommand_paths: [['repo', 'delete', 'force']],
        deny_subcommand_paths: [['repo', 'delete']],
      }),
    ).toThrow(/unreachable/);
  });

  it('across categories: approval path vs deny subcommand prefix → error', () => {
    expect(() =>
      compilePolicy({
        ...BASE,
        approval_subcommand_paths: [['repo', 'delete']],
        deny_subcommands: ['repo'],
      }),
    ).toThrow(/approval_subcommand_paths.*deny_subcommands/);
  });

  it('across categories: approval subcommand vs deny path of one token → error', () => {
    expect(() =>
      compilePolicy({
        ...BASE,
        approval_subcommands: ['repo'],
        deny_subcommand_paths: [['repo']],
      }),
    ).toThrow(/unreachable/);
  });

  it('broader approval than deny compiles (subcommand vs path)', () => {
    expect(() =>
      compilePolicy({
        ...BASE,
        approval_subcommands: ['repo'],
        deny_subcommand_paths: [['repo', 'delete']],
      }),
    ).not.toThrow();
  });

  it('broader approval than deny compiles (path vs path)', () => {
    expect(() =>
      compilePolicy({
        ...BASE,
        approval_subcommand_paths: [['repo']],
        deny_subcommand_paths: [['repo', 'delete']],
      }),
    ).not.toThrow();
  });

  it('token boundary: `re` is not a prefix of `repo` (either direction)', () => {
    expect(() =>
      compilePolicy({ ...BASE, approval_subcommands: ['repo'], deny_subcommands: ['re'] }),
    ).not.toThrow();
    expect(() =>
      compilePolicy({
        ...BASE,
        approval_subcommand_paths: [['re']],
        deny_subcommand_paths: [['repo', 'delete']],
      }),
    ).not.toThrow();
  });

  it('unrelated entries compile', () => {
    expect(() =>
      compilePolicy({ ...BASE, approval_subcommands: ['a'], deny_subcommands: ['b'] }),
    ).not.toThrow();
  });
});
