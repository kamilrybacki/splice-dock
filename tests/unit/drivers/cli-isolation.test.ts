// B (1c): per-call config isolation. Every invocation gets a fresh private
// HOME / XDG_* tree so tool config, aliases and extensions cannot persist
// between calls (gh aliases, gh extensions, kubectl plugins via ~/.krew, ...).
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIsolatedHome, ISOLATED_ENV_KEYS } from '../../../src/services/tools/adapters/cli/isolation.js';
import { callCliPassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';

const mode = (p: string) => statSync(p).mode & 0o777;

let root: string;
const savedRoot = process.env['SPLICEDOCK_TOOL_HOME'];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iso-test-'));
  process.env['SPLICEDOCK_TOOL_HOME'] = root;
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env['SPLICEDOCK_TOOL_HOME'];
  else process.env['SPLICEDOCK_TOOL_HOME'] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('createIsolatedHome', () => {
  it('creates a private 0700 tree under SPLICEDOCK_TOOL_HOME with HOME and XDG_* set', () => {
    const iso = createIsolatedHome('echo');
    try {
      expect(iso.dir.startsWith(root + '/')).toBe(true);
      expect(mode(iso.dir)).toBe(0o700);
      expect(iso.env['HOME']).toBe(iso.dir);
      expect(iso.env['XDG_CONFIG_HOME']).toBe(join(iso.dir, '.config'));
      expect(iso.env['XDG_DATA_HOME']).toBe(join(iso.dir, '.local/share'));
      expect(iso.env['XDG_STATE_HOME']).toBe(join(iso.dir, '.local/state'));
      expect(iso.env['XDG_CACHE_HOME']).toBe(join(iso.dir, '.cache'));
      for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
        expect(mode(iso.env[k]!)).toBe(0o700);
      }
      expect(iso.env['GH_CONFIG_DIR']).toBeUndefined();
    } finally {
      iso.cleanup();
    }
    expect(existsSync(iso.dir)).toBe(false);
  });

  it('sets GH_CONFIG_DIR only for gh (by basename)', () => {
    const iso = createIsolatedHome('/usr/local/bin/gh');
    try {
      expect(iso.env['GH_CONFIG_DIR']).toBe(join(iso.dir, '.config/gh'));
    } finally {
      iso.cleanup();
    }
  });

  it('every call gets a different directory', () => {
    const a = createIsolatedHome('echo');
    const b = createIsolatedHome('echo');
    try {
      expect(a.dir).not.toBe(b.dir);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('cleanup is idempotent and never throws', () => {
    const iso = createIsolatedHome('echo');
    iso.cleanup();
    expect(() => iso.cleanup()).not.toThrow();
  });

  it('lists the keys it owns', () => {
    expect([...ISOLATED_ENV_KEYS].sort()).toEqual(
      ['GH_CONFIG_DIR', 'HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].sort(),
    );
  });
});

function mkConfig(overrides: Partial<CliPassthroughToolConfig> = {}): CliPassthroughToolConfig {
  return {
    type: 'cli_passthrough',
    name: 'env_pass',
    description: 'env for tests',
    command: 'env',
    deny_subcommands: [],
    env: [],
    timeout_ms: 5000,
    ...overrides,
  } as CliPassthroughToolConfig;
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

describe('callCliPassthrough with isolate_config', () => {
  it('runs the tool with a fresh private HOME that is removed afterwards (default on)', async () => {
    const r = await callCliPassthrough(mkConfig(), 'run', { args: [] }, ['env']);
    expect(r.isError).toBeFalsy();
    const env = parseEnv(r.content[0]!.text);
    expect(env['HOME']!.startsWith(root + '/')).toBe(true);
    expect(env['XDG_CONFIG_HOME']).toBe(join(env['HOME']!, '.config'));
    expect(existsSync(env['HOME']!)).toBe(false);
  });

  it('isolation wins over a declared env var with the same name', async () => {
    const saved = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = '/placeholder/declared';
    try {
      const r = await callCliPassthrough(mkConfig({ env: ['XDG_CONFIG_HOME'] }), 'run', { args: [] }, ['env']);
      const env = parseEnv(r.content[0]!.text);
      expect(env['XDG_CONFIG_HOME']).not.toBe('/placeholder/declared');
      expect(env['XDG_CONFIG_HOME']!.startsWith(root + '/')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = saved;
    }
  });

  it('isolate_config: false keeps the process HOME and sets no XDG dirs', async () => {
    const r = await callCliPassthrough(mkConfig({ isolate_config: false }), 'run', { args: [] }, ['env']);
    const env = parseEnv(r.content[0]!.text);
    expect(env['HOME']).toBe(process.env['HOME'] ?? '/tmp');
    expect(env['XDG_CONFIG_HOME']).toBeUndefined();
  });

  it('the help path is isolated too and leaves nothing behind', async () => {
    const r = await callCliPassthrough(mkConfig(), 'help', { subcommand: '' }, ['env']);
    expect(r.content[0]!.text.length).toBeGreaterThan(0);
    expect(readdirSync(root)).toEqual([]);
  });

  // kubectl >= 1.33 reads preferences (default flags, aliases) from $KUBERC or
  // ~/.kube/kuberc. They must never shape a call: kubectl gets KUBERC=off and
  // KUBECTL_KUBERC=false always, even with isolate_config off or a declared
  // KUBERC in the operator env.
  describe('kubectl kuberc pins', () => {
    const fakeKubectl = (): string => {
      const dir = mkdtempSync(join(root, 'bin-'));
      const path = join(dir, 'kubectl');
      // A script, not a symlink: coreutils env is a multicall binary.
      writeFileSync(path, '#!/bin/sh\nexec env\n', { mode: 0o755 });
      return path;
    };
    it.each([[true], [false]])('isolate_config=%s pins KUBERC=off and KUBECTL_KUBERC=false', async isolate => {
      const cmd = fakeKubectl();
      const r = await callCliPassthrough(mkConfig({ command: cmd, isolate_config: isolate }), 'run', { args: [] }, [cmd]);
      expect(r.isError, r.content[0]?.text).toBeFalsy();
      const env = parseEnv(r.content[0]!.text);
      expect(env['KUBERC']).toBe('off');
      expect(env['KUBECTL_KUBERC']).toBe('false');
    });
    it('a declared KUBERC cannot re-enable preferences', async () => {
      const saved = process.env['KUBERC'];
      process.env['KUBERC'] = '/placeholder/kuberc';
      try {
        const cmd = fakeKubectl();
        const r = await callCliPassthrough(mkConfig({ command: cmd, env: ['KUBERC'] }), 'run', { args: [] }, [cmd]);
        expect(parseEnv(r.content[0]!.text)['KUBERC']).toBe('off');
      } finally {
        if (saved === undefined) delete process.env['KUBERC'];
        else process.env['KUBERC'] = saved;
      }
    });
    it('other tools are not pinned', async () => {
      const r = await callCliPassthrough(mkConfig(), 'run', { args: [] }, ['env']);
      expect(parseEnv(r.content[0]!.text)['KUBERC']).toBeUndefined();
    });
  });

  it('a failure to create the isolated home refuses the call without leaking the path', async () => {
    process.env['SPLICEDOCK_TOOL_HOME'] = join(root, 'does-not-exist');
    const r = await callCliPassthrough(mkConfig(), 'run', { args: [] }, ['env']);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/isolated config dir/);
    expect(r.content[0]!.text).not.toContain(root);
  });
});
