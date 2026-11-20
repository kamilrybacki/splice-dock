import { spawn } from 'node:child_process';
import type { CommandProviderConfig } from '../../../config/types.js';
import type { CredentialProvider, MintContext, MintedCredential } from '../../../ports/credentials.js';

const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * The generic provider: run a command, read the credential it prints. One
 * adapter covers every service with a minting CLI, so adding a backend needs no
 * code. The command is trusted operator config and runs with splicedock's
 * privileges (including its env), exactly like a cli_passthrough install script.
 *
 * Templates: `{profile}`, `{agent}`, `{backend}`, `{provider}` are replaced in
 * each argv element. Values are passed as one argv element (shell: false), so
 * they can never split into extra arguments or reach a shell.
 */
export function createCommandProvider(): CredentialProvider {
  return {
    async mint(ctx: MintContext): Promise<MintedCredential> {
      if (ctx.config.type !== 'command') throw new Error('provider_config_mismatch');
      const config: CommandProviderConfig = ctx.config;
      const stdout = await runMintCommand(config, ctx);
      const minted = parseOutput(config, stdout);
      if (minted.secret === '') throw new Error('mint_empty_secret');
      return minted;
    },
  };
}

async function runMintCommand(config: CommandProviderConfig, ctx: MintContext): Promise<string> {
  const args = config.args.map(arg => expand(arg, ctx));
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.command, args, { shell: false, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reject(new Error('mint_spawn_failed'));
      return;
    }
    let stdout = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('mint_timeout')));
    }, config.timeout_ms);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= MAX_OUTPUT_BYTES) return;
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new Error('mint_output_too_large')));
      }
    });
    // Drain stderr so a chatty command cannot fill the pipe and stall; never surface it.
    child.stderr?.resume();
    child.on('error', () => finish(() => reject(new Error('mint_spawn_failed'))));
    child.on('close', (code: number | null) => {
      if (code !== 0) finish(() => reject(new Error(`mint_exit_${code ?? 'null'}`)));
      else finish(() => resolve(stdout));
    });
  });
}

function expand(template: string, ctx: MintContext): string {
  return template.replace(/\{(profile|agent|backend|provider)\}/g, (_match, name: string) => {
    const value = name === 'profile' ? ctx.profile
      : name === 'agent' ? ctx.agent ?? ''
      : name === 'backend' ? ctx.backend
      : ctx.provider;
    // NUL and control characters would be rejected by execve anyway.
    return Array.from(value).filter(ch => ch.charCodeAt(0) >= 0x20).join('');
  });
}

function parseOutput(config: CommandProviderConfig, stdout: string): MintedCredential {
  if (config.output.format === 'text') {
    return { secret: stdout.trim() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('mint_invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('mint_invalid_json');
  const fields = parsed as Record<string, unknown>;
  const secret = fields[config.output.secret_field];
  if (typeof secret !== 'string' || secret === '') throw new Error('mint_empty_secret');

  let expiresAt: number | undefined;
  if (config.output.expires_in_field !== undefined) {
    const seconds = Number(fields[config.output.expires_in_field]);
    if (Number.isFinite(seconds) && seconds > 0) expiresAt = Date.now() + seconds * 1000;
  } else if (config.output.expires_at_field !== undefined) {
    const raw = Number(fields[config.output.expires_at_field]);
    // Accept both epoch seconds and epoch milliseconds.
    if (Number.isFinite(raw) && raw > 0) expiresAt = raw > 1e12 ? raw : raw * 1000;
  }
  return expiresAt === undefined ? { secret } : { secret, expiresAt };
}
