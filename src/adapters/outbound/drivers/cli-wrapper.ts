import type { CompatibilityCallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OperationExchange } from '../../../ports/operation-exchange.js';
import { spawn } from 'node:child_process';
import type { CliToolConfig } from '../../../config/types.js';
import type { McpCallResult } from './shared.js';
export type { McpCallResult } from './shared.js';

export async function callCliTool(
  config: CliToolConfig,
  args: Record<string, string>,
  whitelist: string[],
  exchange?: OperationExchange,
  signal?: AbortSignal,
): Promise<CompatibilityCallToolResult> {
  if (!whitelist.includes(config.command)) {
    return { content: [{ type: 'text', text: `Command '${config.command}' is not in whitelist` }], isError: true };
  }
  const resolvedArgs = config.args.map(arg => substituteArg(arg, args, config.params));
  const cwd = exchange ? process.cwd() : undefined;
  const invoke = async (): Promise<McpCallResult> => {
    signal?.throwIfAborted();
    const env = buildRestrictedEnv(config.env);
    try {
      const { stdout, stderr, exitCode } = await runProcess(config.command, resolvedArgs, env, config.timeout_ms, cwd);
      if (exitCode !== 0) return { content: [{ type: 'text', text: `Exit ${exitCode}: ${stderr || stdout}` }], isError: true };
      return { content: [{ type: 'text', text: stdout || stderr }] };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  };
  return exchange
    ? exchange({ driver: 'cli', command: config.command, argv: resolvedArgs, cwd: cwd! }, async () => await invoke() as CompatibilityCallToolResult)
    : await invoke() as CompatibilityCallToolResult;
}

function substituteArg(template: string, args: Record<string, string>, params: CliToolConfig['params']): string {
  return template.replace(/\{(\w+)\}/g, (_match, name) => {
    const param = params.find(p => p.name === name);
    const raw = args[name] ?? param?.default ?? '';
    // No shell escaping needed — spawn uses shell: false, so values are passed directly.
    return raw;
  });
}

function buildRestrictedEnv(declaredVars: string[]): NodeJS.ProcessEnv {
  // Forward PATH (with SPLICEDOCK_BIN prepended) and HOME so bare command names resolve and
  // tools that read user config work. Matches cli-passthrough-wrapper for consistency.
  const binDir = process.env['SPLICEDOCK_BIN'] ?? '/var/splicedock/bin';
  const basePath = process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const env: NodeJS.ProcessEnv = {
    PATH: `${binDir}:${basePath}`,
    HOME: process.env['HOME'] ?? '/tmp',
  };
  for (const varName of declaredVars) {
    if (process.env[varName] !== undefined) env[varName] = process.env[varName];
  }
  return env;
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    let stdoutBytes = 0; let stderrBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI command '${command}' timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? 1 }); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}
