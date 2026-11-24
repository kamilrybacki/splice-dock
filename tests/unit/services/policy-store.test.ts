import { describe, it, expect, beforeEach } from 'vitest';
import { SplicedockStore } from '../../../src/services/database/adapters/store.js';
import { PolicyStore } from '../../../src/services/policy/base.js';
import { PolicyCompileError } from '../../../src/services/policy/cli/rules.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';

function mkConfig(name: string, filePolicy?: CliPassthroughToolConfig['policy']): CliPassthroughToolConfig {
  return {
    type: 'cli_passthrough',
    name,
    description: 'tool for tests',
    command: 'echo',
    deny_subcommands: [],
    env: [],
    timeout_ms: 5000,
    policy: filePolicy,
  };
}

describe('PolicyStore', () => {
  let store: PolicyStore;
  beforeEach(async () => {
    store = new PolicyStore(await SplicedockStore.open(':memory:'));
  });

  it('effective returns the file policy when no override exists', async () => {
    const cfg = mkConfig('a', { max_args: 256, on_violation: 'deny', audit: false, deny_subcommands: ['delete'] });
    expect((await store.effective(cfg))?.deny_subcommands).toEqual(['delete']);
  });

  it('effective returns the override when one is set', async () => {
    const cfg = mkConfig('a', { max_args: 256, on_violation: 'deny', audit: false, deny_subcommands: ['delete'] });
    await store.setOverride('a', { max_args: 100, on_violation: 'deny', audit: false, allow_subcommands: ['get'] });
    expect((await store.effective(cfg))?.allow_subcommands).toEqual(['get']);
  });

  it('view exposes file/override/effective', async () => {
    const cfg = mkConfig('a', { max_args: 256, on_violation: 'deny', audit: false });
    await store.setOverride('a', { max_args: 10, on_violation: 'deny', audit: true });
    const v = await store.view(cfg);
    expect(v.file_policy?.max_args).toBe(256);
    expect(v.override?.max_args).toBe(10);
    expect(v.effective?.max_args).toBe(10);
  });

  it('rejects an override with a malformed regex', async () => {
    await expect(async () => await store.setOverride('a', {
            max_args: 256, on_violation: 'deny', audit: false,
            deny_args_regex: ['[broken'],
          })).rejects.toThrow(PolicyCompileError);
  });

  it('rejects an override whose bare requirement names a value-taking flag of the tool', async () => {
    const policy = { max_args: 256, on_violation: 'deny' as const, audit: false, require_args: ['--namespace'] };
    await expect(async () => await store.setOverride('k', policy, null, { command: 'kubectl' })).rejects.toThrow(/bare requirement "--namespace"/);
    expect((await store.view(mkConfig('k'))).override).toBeNull();
    await store.setOverride('k', { ...policy, require_args: ['--namespace=apps'] }, null, { command: 'kubectl' });
  });

  it('deleteOverride returns true on hit, false otherwise', async () => {
    await store.setOverride('a', { max_args: 10, on_violation: 'deny', audit: false });
    expect(await store.deleteOverride('a')).toBe(true);
    expect(await store.deleteOverride('a')).toBe(false);
  });

  it('onChange listeners fire on set + delete', async () => {
    const seen: string[] = [];
    store.onChange(t => seen.push(t));
    await store.setOverride('a', { max_args: 10, on_violation: 'deny', audit: false });
    await store.setOverride('b', { max_args: 20, on_violation: 'deny', audit: false });
    await store.deleteOverride('a');
    expect(seen).toEqual(['a', 'b', 'a']);
  });

  describe('profile overrides', () => {
    const file = { max_args: 256, on_violation: 'deny' as const, audit: false, deny_subcommands: ['delete'] };
    const glob = { max_args: 100, on_violation: 'deny' as const, audit: false, allow_subcommands: ['get'] };
    const prof = { max_args: 50, on_violation: 'deny' as const, audit: false, allow_subcommands: ['get', 'delete'] };

    it('resolves profile override -> all-profiles override -> file policy', async () => {
      const cfg = mkConfig('k', file);
      expect((await store.effective(cfg, 'ops'))?.deny_subcommands).toEqual(['delete']);
      await store.setOverride('k', glob);
      expect((await store.effective(cfg, 'ops'))?.allow_subcommands).toEqual(['get']);
      await store.setProfileOverride('k', 'ops', prof);
      expect((await store.effective(cfg, 'ops'))?.allow_subcommands).toEqual(['get', 'delete']);
      expect((await store.effective(cfg, 'dev'))?.allow_subcommands).toEqual(['get']);
      expect((await store.effective(cfg))?.allow_subcommands).toEqual(['get']);
    });

    it('lists profiles and removes an override', async () => {
      const cfg = mkConfig('k', file);
      await store.setProfileOverride('k', 'b', prof);
      await store.setProfileOverride('k', 'a', prof);
      expect((await store.view(cfg)).profile_overrides).toEqual(['a', 'b']);
      expect(await store.deleteProfileOverride('k', 'a')).toBe(true);
      expect(await store.deleteProfileOverride('k', 'a')).toBe(false);
      expect(await store.getProfileOverride('k', 'a')).toBeNull();
    });

    it('rejects an uncompilable profile override without storing it', async () => {
      await expect(store.setProfileOverride('k', 'ops', { max_args: 1, on_violation: 'deny', audit: false, deny_args_regex: ['[broken'] } as never)).rejects.toBeInstanceOf(PolicyCompileError);
      expect(await store.getProfileOverride('k', 'ops')).toBeNull();
    });

    it('fires change listeners', async () => {
      const seen: string[] = [];
      store.onChange(t => seen.push(t));
      await store.setProfileOverride('k', 'ops', prof);
      await store.deleteProfileOverride('k', 'ops');
      expect(seen).toEqual(['k', 'k']);
    });
  });
});
