import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolSchema } from '../../../src/config/schema.js';

// A user who installs global npm packages without root usually has
// NPM_CONFIG_PREFIX exported. npm reads that name too, so it must not reach the
// install script next to the gateway's own npm_config_prefix.
describe('cli_passthrough install script environment', () => {
  let binDir: string;

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'splicedock-bin-'));
    vi.stubEnv('SPLICEDOCK_BIN', binDir);
    vi.stubEnv('NPM_CONFIG_PREFIX', '/somewhere/else');
    vi.stubEnv('NPM_CONFIG_CACHE', '/somewhere/else/cache');
    vi.resetModules();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(binDir, { recursive: true, force: true });
  });

  it('gives npm one prefix and one cache, both under SPLICEDOCK_BIN', async () => {
    const { installCliPassthroughTools } = await import('../../../src/adapters/outbound/installer/cli-installer.js');
    const tool = toolSchema.parse({
      type: 'cli_passthrough',
      name: 'envprobe',
      description: 'Records the npm settings the install script sees',
      command: 'envprobe',
      install: {
        script: [
          'env | grep -i "^npm_config_\\(prefix\\|cache\\)=" | sort > "$SPLICEDOCK_BIN/npm-env.txt"',
          'printf "#!/bin/sh\\n" > "$SPLICEDOCK_BIN/envprobe"',
          'chmod +x "$SPLICEDOCK_BIN/envprobe"',
        ].join('\n'),
      },
    });

    if (tool.type !== 'cli_passthrough') throw new Error('expected a cli_passthrough tool');

    const [result] = await installCliPassthroughTools([tool]);

    expect(result?.status).toBe('available');
    expect(readFileSync(join(binDir, 'npm-env.txt'), 'utf8').trim().split('\n')).toEqual([
      `npm_config_cache=${binDir}/.npm-cache`,
      `npm_config_prefix=${binDir}`,
    ]);
  });

  it('completes an install that writes more than a pipe buffer to stdout', async () => {
    const { installCliPassthroughTools } = await import('../../../src/adapters/outbound/installer/cli-installer.js');
    const tool = toolSchema.parse({
      type: 'cli_passthrough',
      name: 'stdoutprobe',
      description: 'Writes to stdout before installing the executable',
      command: 'stdoutprobe',
      install: {
        script: [
          'head -c 1048576 /dev/zero',
          'printf "#!/bin/sh\\n" > "$SPLICEDOCK_BIN/stdoutprobe"',
          'chmod +x "$SPLICEDOCK_BIN/stdoutprobe"',
        ].join('\n'),
        timeout_ms: 3000,
      },
    });

    if (tool.type !== 'cli_passthrough') throw new Error('expected a cli_passthrough tool');

    const [result] = await installCliPassthroughTools([tool]);
    expect(result?.status).toBe('available');
  });
});
