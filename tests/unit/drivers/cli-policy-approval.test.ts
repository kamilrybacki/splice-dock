import { describe, it, expect, vi } from 'vitest';
import { compilePolicy, evaluatePolicy, type ApprovalHook } from '../../../src/domain/policy/cli-policy.js';

const BASE = { max_args: 256, on_violation: 'deny' as const, audit: false };

describe('evaluatePolicy approval rules', () => {
  it('approval_subcommands without hook → block with rule=approval_subcommands', () => {
    const p = compilePolicy({ ...BASE, approval_subcommands: ['undo'] });
    const r = evaluatePolicy(['undo', 'deploy/x'], p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe('approval_subcommands');
  });

  it('approval_subcommand_paths without hook → block', () => {
    const p = compilePolicy({ ...BASE, approval_subcommand_paths: [['rollout', 'undo']] });
    const r = evaluatePolicy(['rollout', 'undo', 'deploy/x'], p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe('approval_subcommand_paths');
  });

  it('approval hook returning approved bypasses', async () => {
    const p = compilePolicy({ ...BASE, approval_subcommand_paths: [['rollout', 'undo']] });
    const fn = vi.fn().mockReturnValue({ approved: true, id: 'abc' });
    const r = await evaluatePolicy(['rollout', 'undo', 'deploy/x'], p, { tool: 'kubectl', fn: fn as ApprovalHook });
    expect(r.ok).toBe(true);
    if (r.ok && 'approval' in r) expect(r.approval.reserved_id).toBe('abc');
  });

  it('approval hook returning not-approved blocks with pending_approval payload', async () => {
    const p = compilePolicy({ ...BASE, approval_subcommand_paths: [['rollout', 'undo']] });
    const fn = vi.fn().mockReturnValue({ approved: false, id: 'pending-1', expires_at: 99 });
    const r = await evaluatePolicy(['rollout', 'undo'], p, { tool: 'kubectl', fn: fn as ApprovalHook });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rule).toBe('approval_subcommand_paths');
      expect(r.pending_approval).toEqual({ id: 'pending-1', expires_at: 99 });
    }
  });

  it('identity-refused verdict blocks with rule=approval_requires_profile_token and no pending id', async () => {
    const p = compilePolicy({ ...BASE, approval_subcommand_paths: [['rollout', 'undo']] });
    const fn = vi.fn().mockReturnValue({ approved: false, refused: 'approval_requires_profile_token' });
    const r = await evaluatePolicy(['rollout', 'undo'], p, { tool: 'kubectl', fn: fn as ApprovalHook });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rule).toBe('approval_requires_profile_token');
      expect(r.pending_approval).toBeUndefined();
      expect(r.message).toMatch(/authenticated profile token/);
      expect(r.matched).toBe('rollout undo');
    }
  });

  it('credential guards fire BEFORE approval bypass (deny_args wins)', async () => {
    const p = compilePolicy({
      ...BASE,
      approval_subcommand_paths: [['rollout', 'undo']],
      deny_args_regex: ['^--token='],
    });
    const fn = vi.fn().mockReturnValue({ approved: true, id: 'abc' });
    const r = await evaluatePolicy(['rollout', 'undo', '--token=hunter2'], p, { tool: 'kubectl', fn: fn as ApprovalHook });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe('deny_args_regex');
    expect(fn).not.toHaveBeenCalled();
  });

  it('approval rules overlapping with deny lists is rejected at compile', () => {
    expect(() =>
      compilePolicy({
        ...BASE,
        deny_subcommands: ['undo'],
        approval_subcommands: ['undo'],
      }),
    ).toThrow(/unreachable/);
  });
});
