// An operator-declared KUBECONFIG must be absolute (Codex release review of
// bb03af5). A relative path resolves against the call's cwd, which the MCP
// caller picks, so the caller could plant its own kubeconfig. The loader
// rejects it at startup and on SIGHUP for every source it can read without a
// live call (bare names and env: refs). vault: refs, and anything else that
// changes after load, are checked again before every spawn.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../../src/config/loader.js';
import { callCliPassthrough } from '../../../src/adapters/outbound/drivers/cli-passthrough-wrapper.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';

const VARS = ['KUBECONFIG', 'SPLICEDOCK_TEST_KCFG'] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(VARS.map(v => [v, process.env[v]]));
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

const yaml = (envBlock: string) => `
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
  cli_whitelist: [kubectl]
profiles: {}
tools:
  - type: cli_passthrough
    name: kube
    description: kubectl
    command: /usr/local/bin/kubectl
    env:
${envBlock}
`;
const BARE = yaml('      - KUBECONFIG');
const FROM_ENV = yaml('      - name: KUBECONFIG\n        from: "env:SPLICEDOCK_TEST_KCFG"');
const FROM_VAULT = yaml('      - name: KUBECONFIG\n        from: "vault:secret/data/example/kube#config"');

describe('loader: KUBECONFIG must be absolute', () => {
  it.each(['kubeconfig', './kube/config', '../config', 'a/b'])('a relative bare KUBECONFIG %s is rejected', value => {
    process.env['KUBECONFIG'] = value;
    expect(() => parseConfig(BARE)).toThrow(/cli_passthrough 'kube': KUBECONFIG must be an absolute path/);
  });
  it('a relative KUBECONFIG from an env: ref is rejected', () => {
    process.env['SPLICEDOCK_TEST_KCFG'] = 'config';
    expect(() => parseConfig(FROM_ENV)).toThrow(/KUBECONFIG must be an absolute path/);
  });
  it('a colon list with one relative entry is rejected', () => {
    process.env['KUBECONFIG'] = '/etc/kube/a:relative/b';
    expect(() => parseConfig(BARE)).toThrow(/KUBECONFIG must be an absolute path/);
  });
  it('the error does not echo the path', () => {
    process.env['KUBECONFIG'] = 'secret-looking-name';
    let message = '';
    try {
      parseConfig(BARE);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/KUBECONFIG/);
    expect(message).not.toContain('secret-looking-name');
  });
  it.each(['/etc/kube/config', '/etc/kube/a:/etc/kube/b'])('an absolute KUBECONFIG %s loads', value => {
    process.env['KUBECONFIG'] = value;
    expect(parseConfig(BARE).tools).toHaveLength(1);
    process.env['SPLICEDOCK_TEST_KCFG'] = value;
    expect(parseConfig(FROM_ENV).tools).toHaveLength(1);
  });
  it('a declared but unset KUBECONFIG loads (in-cluster service account)', () => {
    delete process.env['KUBECONFIG'];
    delete process.env['SPLICEDOCK_TEST_KCFG'];
    expect(parseConfig(BARE).tools).toHaveLength(1);
    expect(parseConfig(FROM_ENV).tools).toHaveLength(1);
  });
  it('every KUBECONFIG ref is checked, not only the first', () => {
    process.env['KUBECONFIG'] = '/etc/kube/config';
    process.env['SPLICEDOCK_TEST_KCFG'] = 'relative';
    const both = yaml('      - KUBECONFIG\n      - name: KUBECONFIG\n        from: "env:SPLICEDOCK_TEST_KCFG"');
    expect(() => parseConfig(both)).toThrow(/KUBECONFIG must be an absolute path/);
  });
  it('a vault: ref is not resolved at load (no live call); it is checked at call time', () => {
    expect(parseConfig(FROM_VAULT).tools).toHaveLength(1);
  });
});

describe('callCliPassthrough: KUBECONFIG is checked again before spawning', () => {
  const run = async (env: CliPassthroughToolConfig['env']) => {
    const dir = mkdtempSync(join(tmpdir(), 'kube-kcfg-'));
    const marker = join(dir, 'ran');
    const cmd = join(dir, 'kubectl');
    writeFileSync(cmd, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const config = {
      type: 'cli_passthrough', name: 'kube_kcfg', description: 'kubectl', command: cmd,
      deny_subcommands: [], env, timeout_ms: 5000, isolate_config: false,
    } as unknown as CliPassthroughToolConfig;
    try {
      const r = await callCliPassthrough(config, 'run', { args: ['get', 'pods'] }, [cmd]);
      return { isError: r.isError === true, ran: existsSync(marker), text: r.content[0]?.text ?? '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it('a bare KUBECONFIG that turned relative after load is refused', async () => {
    process.env['KUBECONFIG'] = 'config';
    const r = await run(['KUBECONFIG']);
    expect(r).toMatchObject({ isError: true, ran: false });
    expect(r.text).toMatch(/KUBECONFIG must be an absolute path/);
  });
  it('a relative KUBECONFIG from an env: ref is refused', async () => {
    process.env['SPLICEDOCK_TEST_KCFG'] = 'kube/config';
    const r = await run([{ name: 'KUBECONFIG', from: 'env:SPLICEDOCK_TEST_KCFG' }]);
    expect(r).toMatchObject({ isError: true, ran: false });
  });
  it('an absolute KUBECONFIG runs', async () => {
    process.env['KUBECONFIG'] = '/etc/kube/config';
    expect(await run(['KUBECONFIG'])).toMatchObject({ isError: false, ran: true });
  });
});
