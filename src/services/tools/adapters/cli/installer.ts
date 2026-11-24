import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import type { CliPassthroughToolConfig } from '../../../../config/types.js';
import { logger } from '../../../../common/logger.js';

/** Where splicedock self-installs cli_passthrough binaries. Writable by the splicedock user. */
export const SPLICEDOCK_BIN = process.env['SPLICEDOCK_BIN'] ?? '/var/splicedock/bin';

/** npm settings the installer sets itself; inherited copies in any letter case are dropped. */
const NPM_SETTINGS_SET_BY_INSTALLER: ReadonlySet<string> = new Set(['npm_config_prefix', 'npm_config_cache']);

export interface InstallResult {
  name: string;
  status: 'available' | 'failed';
  reason: string;
  durationMs: number;
  resolvedPath?: string;
}

/**
 * Ensure every declared cli_passthrough tool is actually available on PATH. For each:
 *   1. Probe first — if the binary already exists, skip install (cached binary from a prior run
 *      or a pre-baked image).
 *   2. If not present and an install block is declared, run the install script.
 *   3. Probe again — if the binary still isn't found, mark the tool failed.
 *
 * The result of this phase is the authoritative "is this tool usable" signal: the caller
 * should only register tools whose status is `available`. Runs in parallel. Failures are
 * logged and returned; `install.required: true` escalates to a thrown error.
 */
export async function installCliPassthroughTools(
  configs: CliPassthroughToolConfig[],
): Promise<InstallResult[]> {
  if (configs.length === 0) return [];

  await mkdir(SPLICEDOCK_BIN, { recursive: true });

  const results = await Promise.all(configs.map(installOne));

  const required = results.filter(r => {
    if (r.status !== 'failed') return false;
    const cfg = configs.find(c => c.name === r.name);
    return cfg?.install?.required === true;
  });

  if (required.length > 0) {
    const names = required.map(r => r.name).join(', ');
    throw new Error(`Required cli_passthrough install(s) failed: ${names}`);
  }

  return results;
}

async function installOne(config: CliPassthroughToolConfig): Promise<InstallResult> {
  const start = Date.now();

  // 1. Availability probe — is the binary already on PATH?
  let resolved = await resolveBin(config.command);
  if (resolved) {
    return {
      name: config.name,
      status: 'available',
      reason: 'binary already present',
      durationMs: Date.now() - start,
      resolvedPath: resolved,
    };
  }

  // 2. No install block → there's nothing we can do. Tool is unavailable.
  if (!config.install) {
    const msg = `'${config.command}' is not on PATH and no install block is declared`;
    logger.warn('cli_passthrough unavailable', { tool: config.name, reason: msg });
    return { name: config.name, status: 'failed', reason: msg, durationMs: Date.now() - start };
  }

  // 3. Run install script.
  logger.info('installing cli_passthrough tool', { tool: config.name });
  try {
    await runInstallScript(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('cli_passthrough install failed', { tool: config.name, error: msg });
    return { name: config.name, status: 'failed', reason: msg, durationMs: Date.now() - start };
  }

  // 4. Post-install verification — did the binary land on PATH?
  resolved = await resolveBin(config.command);
  if (!resolved) {
    const msg = `install completed but '${config.command}' is not on PATH (SPLICEDOCK_BIN=${SPLICEDOCK_BIN})`;
    logger.error('cli_passthrough install verification failed', { tool: config.name, reason: msg });
    return { name: config.name, status: 'failed', reason: msg, durationMs: Date.now() - start };
  }

  logger.info('cli_passthrough installed', {
    tool: config.name,
    resolved_path: resolved,
    duration_ms: Date.now() - start,
  });
  return {
    name: config.name,
    status: 'available',
    reason: 'newly installed',
    durationMs: Date.now() - start,
    resolvedPath: resolved,
  };
}

/**
 * Resolve a command to an absolute path by walking PATH (with SPLICEDOCK_BIN prepended).
 * Returns undefined if not found or not executable.
 */
async function resolveBin(command: string): Promise<string | undefined> {
  if (command.includes('/')) {
    return (await isExecutable(command)) ? command : undefined;
  }
  const basePath = process.env['PATH'] ?? '';
  const dirs = [SPLICEDOCK_BIN, ...basePath.split(':').filter(Boolean)];
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runInstallScript(config: CliPassthroughToolConfig): Promise<void> {
  if (!config.install) return Promise.resolve();
  const { script, env: userEnv, timeout_ms: timeoutMs } = config.install;

  // Inherit the full splicedock env so install scripts can read operator-provided vars (URLs,
  // tokens). Then layer: SPLICEDOCK_BIN, PATH (with bin prepended), HOME redirected to the
  // writable bin dir (root fs is read-only, so default HOME=/home/node is not writable), plus
  // npm-specific overrides so `npm install -g` targets SPLICEDOCK_BIN and npm's cache/logs
  // go to a writable location. User-declared install.env takes precedence.
  // npm reads these settings under any letter case, so an inherited NPM_CONFIG_PREFIX would
  // compete with the npm_config_prefix set here. Drop the inherited ones first.
  const basePath = process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !NPM_SETTINGS_SET_BY_INSTALLER.has(key.toLowerCase())),
  );
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    SPLICEDOCK_BIN,
    PATH: `${SPLICEDOCK_BIN}:${basePath}`,
    HOME: SPLICEDOCK_BIN,
    npm_config_prefix: SPLICEDOCK_BIN,
    npm_config_cache: `${SPLICEDOCK_BIN}/.npm-cache`,
    ...userEnv,
  };

  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-eu', '-c', script], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Install script for '${config.name}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Install script for '${config.name}' exited ${code}: ${stderr.trim()}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
