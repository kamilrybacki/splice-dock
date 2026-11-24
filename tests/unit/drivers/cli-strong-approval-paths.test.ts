// Strong-approval paths (gh: `repo delete`, #29): a gh tool runs them only when
// its policy routes them to approval, and that approval always needs WebAuthn.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CircuitBreaker } from '../../../src/services/policy/circuit-breaker.js';
import { compilePolicy } from '../../../src/services/policy/cli-policy.js';
import type { CliToolPolicy } from '../../../src/config/schema.js';
import {
  callCliPassthrough,
  setApprovalHookFactory,
  setCircuitBreaker,
  type ApprovalHookFactory,
} from '../../../src/services/tools/adapters/cli/passthrough.js';
import { runWithCaller } from '../../../src/common/request-context.js';
import { sqliteDb } from '../../helpers/sqlite.js';

const caller = { profile: 'test', tokenId: 'one', authenticated: true };
const breakerConfig = {
  enabled: true, mode: 'enforce' as const, window_seconds: 60, deny_threshold: 1,
  cooldown_seconds: 1800, half_open_probes: 3, scopes: ['token'], read_allowlist: [],
};

// The policy from docs/architecture.md ("Strong-consent YAML tools").
const repoDeletePolicy = {
  allow_subcommand_paths: [['repo', 'delete']],
  approval_subcommand_paths: [['repo', 'delete']],
};

const tool = (policy?: Record<string, unknown>) => ({
  type: 'cli_passthrough' as const, name: policy ? 'gh_repo_delete' : 'gh', command: 'gh',
  description: 'test', env: [], timeout_ms: 5000, ...(policy ? { policy } : {}),
});

// A fake `gh` first on PATH, so the tests never depend on the real binary.
let binDir: string;
let savedPath: string | undefined;
beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  writeFileSync(join(binDir, 'gh'), '#!/bin/sh\necho "fake gh $*"\n');
  chmodSync(join(binDir, 'gh'), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${savedPath ?? ''}`;
});
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(binDir, { recursive: true, force: true });
});

describe('gh repo delete as a YAML tool', () => {
  it('the documented policy compiles (approval path not shadowed by a deny)', () => {
    expect(() => compilePolicy(repoDeletePolicy as unknown as CliToolPolicy, { command: 'gh' })).not.toThrow();
  });

  it('a gh tool whose policy does not route repo delete to approval refuses it and counts a denial', async () => {
    const breaker = await CircuitBreaker.create(sqliteDb(new Database(':memory:')), breakerConfig);
    setCircuitBreaker(breaker);
    try {
      const out = await runWithCaller(caller, () =>
        callCliPassthrough(tool(), 'run', { args: ['repo', 'delete', 'owner/repo', '--yes'] }, ['gh']));
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toContain('hard_deny');
      expect(out.content[0]!.text).not.toContain('fake gh');
      expect((await breaker.list())[0]?.state).toBe('open');
    } finally {
      setCircuitBreaker(null);
    }
  });

  it('ambiguous argv around repo delete is refused before policy', async () => {
    const out = await runWithCaller(caller, () =>
      callCliPassthrough(tool(repoDeletePolicy), 'run', { args: ['--unknown-flag', 'repo', 'delete', 'x'] }, ['gh']));
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/broker_required|ambiguous_argv/);
    expect(out.content[0]!.text).not.toContain('fake gh');
  });

  it('a tool routing repo delete to approval asks for strong consent and does not run', async () => {
    const seen: Array<{ tool: string; requireStrong?: boolean }> = [];
    const factory: ApprovalHookFactory = (toolName, ctx) => {
      seen.push({ tool: toolName, requireStrong: ctx.requireStrong });
      return () => ({ approved: false, id: 'pending-1', expires_at: Date.now() + 60_000 });
    };
    setApprovalHookFactory(factory);
    try {
      const out = await runWithCaller(caller, () =>
        callCliPassthrough(tool(repoDeletePolicy), 'run', { args: ['repo', 'delete', 'owner/repo', '--yes'] }, ['gh']));
      expect(seen).toEqual([{ tool: 'gh_repo_delete', requireStrong: true }]);
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toContain('pending-1');
      expect(out.content[0]!.text).not.toContain('fake gh');
    } finally {
      setApprovalHookFactory(null);
    }
  });

  it('other gh commands keep weak consent', async () => {
    const seen: Array<boolean | undefined> = [];
    setApprovalHookFactory((_t, ctx) => {
      seen.push(ctx.requireStrong);
      return () => ({ approved: false, id: 'pending-2', expires_at: Date.now() + 60_000 });
    });
    try {
      await runWithCaller(caller, () =>
        callCliPassthrough(tool({ approval_subcommand_paths: [['pr', 'merge']] }), 'run', { args: ['pr', 'merge', '1'] }, ['gh']));
      expect(seen).toEqual([false]);
    } finally {
      setApprovalHookFactory(null);
    }
  });
});
