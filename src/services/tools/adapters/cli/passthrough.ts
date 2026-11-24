import type { ToolResult } from '../../../../contracts/outbound/tool-result.js';
import type { OperationExchange } from '../../../../contracts/outbound/operation/exchange.js';
import type { PolicyDecisionEvent, ToolHooks } from '../../hooks.js';
import { extractSubcommandPaths, flagTableFor } from '../../../policy/cli/flags/arity.js';
import { cliProfileFor } from '../../../policy/cli/profiles/index.js';
import { requireSecret } from '../../../secrets/adapters/vault/guard.js';
import { resolveMintedCredential } from '../../../secrets/broker.js';
import { createIsolatedHome, toolEnvPins, type IsolatedHome } from './isolation.js';
import { KUBECONFIG_RELATIVE_MESSAGE, KUBECONFIG_VAR, kubeconfigIsRelative } from '../../../policy/cli/kubeconfig/path.js';
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve as resolvePath } from 'node:path';
import type { CliPassthroughToolConfig } from '../../../../config/types.js';
import { logger } from '../../../../common/logger.js';
import { currentCaller, type CallerIdentity } from '../../../../common/request/context.js';
import {
  compilePolicy,
  evaluatePolicy,
  PolicyCompileError,
  type CompiledCliPolicy,
} from '../../../policy/cli/rules.js';
import type { McpCallResult } from '../../../../contracts/internal/mcp/result.js';
import { ArgvCanonicalizationError, canonicalizeArgv } from '../../../policy/operation.js';
export type { McpCallResult } from '../../../../contracts/internal/mcp/result.js';

export type {
  ApprovalHookFactory,
  ApprovalSettler,
  AuditSink,
  EffectivePolicyResolver,
  MetricsSink,
  ObservationSink,
  PolicyDecisionEvent,
  ProfileEnvResolver,
  ToolHooks,
} from '../../hooks.js';

// The injected hooks. Replaced wholesale (never mutated) by configurePassthrough.
let injected: ToolHooks = {};

/** Install the passthrough's collaborators (called once at startup; tests
 *  call it per case). Replaces the whole set, so omitted hooks fall back to
 *  their defaults, and drops compiled policies since the resolver may differ. */
export function configurePassthrough(next: ToolHooks): void {
  injected = { ...next };
  policyCache = new WeakMap();
}

/** Invalidate the cached compiled policy for a single tool. Called by
 *  PolicyStore.onChange so a freshly-applied runtime override takes effect
 *  on the very next `__run` without restarting the daemon. */
export function invalidatePolicyForTool(toolName: string): void {
  // WeakMap can't be enumerated; rebuild it (cheap — compile is microseconds).
  policyCache = new WeakMap();
  logger.debug('policy cache invalidated', { tool: toolName });
}

/** Extract the concrete env var name from either form (bare string or { name, from }). */
function envRefName(ref: CliPassthroughToolConfig['env'][number]): string {
  return typeof ref === 'string' ? ref : ref.name;
}

/**
 * Env refs for one call. A profile override replaces same-named entries of the
 * tool's own list and may add new ones, so one profile's credential (GH_TOKEN,
 * a kubeconfig) is never handed to another profile's child process.
 */
function effectiveEnvRefs(config: CliPassthroughToolConfig, profile: string): CliPassthroughToolConfig['env'] {
  const override = injected.profileEnvResolver?.(config.name, profile);
  if (!override || override.length === 0) return config.env;
  const replaced = new Set(override.map(envRefName));
  return [...config.env.filter(ref => !replaced.has(envRefName(ref))), ...override];
}

export type CliPassthroughKind = 'help' | 'run';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Cache of CompiledCliPolicy keyed by CliPassthroughToolConfig identity. The
 * config is expected to be immutable after loader.ts::parseConfig runs (the
 * runtime never edits it). Mutating a config in-place after first __run is
 * unsupported and will keep the stale compiled form — reload through
 * parseConfig to refresh.
 *
 * Production configs always flow through `normalizeCliPassthroughPolicy`,
 * which eagerly merges legacy `deny_subcommands` into `policy.deny_subcommands`
 * and pre-compiles the policy. The fallback synthesis here handles the
 * minority case where a config is constructed programmatically (tests, ad-hoc
 * scripts) without going through the loader.
 */
let policyCache = new WeakMap<CliPassthroughToolConfig, Map<string, CompiledCliPolicy>>();

async function policyFor(config: CliPassthroughToolConfig): Promise<CompiledCliPolicy> {
  // Capture the map: an invalidation while the resolver is awaited replaces
  // policyCache, so the stale compile lands in the discarded map, not the live one.
  const cache = policyCache;
  // Compiled per caller profile: a profile-scoped override changes the policy.
  const profile = currentCaller()?.profile;
  const key = profile ?? '';
  const cached = cache.get(config)?.get(key);
  if (cached) return cached;

  const legacy = config.deny_subcommands ?? [];
  const policyDeny = config.policy?.deny_subcommands ?? [];
  // Same guard as the loader, so configs constructed outside parseConfig can't
  // silently drop the legacy field (security-review finding #3).
  if (legacy.length > 0 && policyDeny.length > 0) {
    throw new Error(
      `cli_passthrough '${config.name}': set deny_subcommands at the top level OR inside policy, not both`,
    );
  }

  // Runtime override from the PolicyStore wins over the file policy when wired.
  const filePolicy =
    config.policy ??
    (legacy.length > 0
      ? {
          max_args: 256,
          on_violation: 'deny' as const,
          audit: false,
          deny_subcommands: legacy,
        }
      : undefined);
  const synthesized = injected.effectivePolicyResolver ? (await injected.effectivePolicyResolver(config, profile)) ?? filePolicy : filePolicy;

  let compiled: CompiledCliPolicy;
  try {
    compiled = compilePolicy(synthesized, { command: config.command, knownSubcommands: config.known_subcommands });
  } catch (err) {
    if (err instanceof PolicyCompileError) {
      logger.error('policy compile failed', { tool: config.name, error: err.message });
      throw err;
    }
    throw err;
  }
  const perProfile = cache.get(config) ?? new Map<string, CompiledCliPolicy>();
  perProfile.set(key, compiled);
  cache.set(config, perProfile);
  return compiled;
}

export async function callReviewedCliPassthrough(
  config: CliPassthroughToolConfig,
  kind: CliPassthroughKind,
  args: Record<string, unknown>,
  whitelist: string[],
  exchange: OperationExchange,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (!whitelist.includes(config.command)) return errorResult('Command is not in cli_whitelist') as ToolResult;
  const approvalContext = args.approval_context;
  if (approvalContext !== undefined && (typeof approvalContext !== 'string' || approvalContext.length > 500)) {
    return errorResult('approval_context must be at most 500 characters') as ToolResult;
  }
  let argv: readonly string[];
  try {
    if (kind === 'help') {
      const parts = (typeof args.subcommand === 'string' ? args.subcommand : '').trim().split(/\s+/).filter(Boolean);
      if (parts.some(part => !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(part))) return errorResult('Help subcommand must contain command words only') as ToolResult;
      argv = ['--help', ...parts];
    } else {
      argv = canonicalizeArgv(args.args);
    }
  } catch (err) {
    if (!(err instanceof ArgvCanonicalizationError)) throw err;
    return errorResult(argvErrorMessage(err)) as ToolResult;
  }
  const cwd = kind === 'run' ? resolveRunCwd(args.cwd) : process.cwd();
  return exchange({ driver: 'cli_passthrough', command: config.command, argv, cwd, approvalContext }, async () =>
    await callCliPassthrough(config, kind, args, whitelist, { argv, cwd, signal }) as ToolResult);
}

export async function callCliPassthrough(
  config: CliPassthroughToolConfig,
  kind: CliPassthroughKind,
  args: Record<string, unknown>,
  whitelist: string[],
  reviewed?: { argv: readonly string[]; cwd: string; signal: AbortSignal },
): Promise<McpCallResult> {
  reviewed?.signal.throwIfAborted();
  if (args.approval_context !== undefined && (typeof args.approval_context !== 'string' || args.approval_context.length > 500)) return errorResult('approval_context must be at most 500 characters');
  if (!whitelist.includes(config.command)) {
    return errorResult(`Command '${config.command}' is not in cli_whitelist`);
  }

  let cmdArgs: readonly string[];
  let runCwd: string | undefined;
  let runEnv: NodeJS.ProcessEnv | undefined;
  let reservedId: string | undefined;
  const caller = currentCaller();
  const envRefs = effectiveEnvRefs(config, caller?.profile ?? '');
  if (kind === 'help') {
    const raw = typeof args['subcommand'] === 'string' ? args['subcommand'] : '';
    const parts = raw.trim().split(/\s+/).filter(s => s.length > 0);
    // Help accepts command words only: a trailing value flag could consume
    // --help and execute an operation instead of displaying documentation.
    if (parts.some(part => !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(part))) {
      return errorResult('Help subcommand must contain command words only');
    }
    cmdArgs = reviewed?.argv ?? ['--help', ...parts];
  } else {
    // One canonical argv (src/services/policy/operation.ts): the exact strings that
    // the policy sees, the approval is bound to, and spawn receives.
    // Validated BEFORE the policy runs, so an approval is never reserved for
    // a call that cannot start.
    try {
      cmdArgs = reviewed?.argv ?? canonicalizeArgv(args['args']);
    } catch (err) {
      if (!(err instanceof ArgvCanonicalizationError)) throw err;
      return errorResult(argvErrorMessage(err));
    }
    // Paths the CLI's profile refuses outright (gh: api) or admits only through
    // a strong approval (gh: repo delete). Ambiguous argv is refused.
    const { requiresBroker, strongApprovalPaths } = cliProfileFor(config.command) ?? {};
    let needsStrong = false;
    if (kind === 'run' && (requiresBroker || strongApprovalPaths)) {
      const candidates = extractSubcommandPaths(cmdArgs, flagTableFor(config.command));
      needsStrong = Boolean(strongApprovalPaths && candidates?.some(strongApprovalPaths));
      if (!candidates || (requiresBroker && candidates.some(requiresBroker))) {
        try {
          await injected.circuitBreaker?.securityDenial(currentCaller());
        } catch {
          if (injected.circuitBreaker?.config.mode !== 'observe') return errorResult('breaker_unavailable');
        }
        return errorResult('broker_required');
      }
    }
    runCwd = reviewed?.cwd ?? resolveRunCwd(args['cwd']);
    runEnv = buildRestrictedEnv(envRefs.map(envRefName));
    const commandError = checkCommand(config.command, runEnv['PATH'] ?? '', runCwd);
    if (commandError) return errorResult(commandError);

    let compiled: CompiledCliPolicy;
    try {
      compiled = await policyFor(config);
    } catch (err) {
      return errorResult(
        `Policy for '${config.name}' is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let forced:boolean;
    try {forced=await injected.circuitBreaker?.force(currentCaller(),config.name,cmdArgs)??false;} catch {if(injected.circuitBreaker?.config.mode!=='observe')return errorResult('breaker_unavailable');forced=false;}
    const approvalHook = injected.approvalHookFactory
      ? { tool: config.name, fn: injected.approvalHookFactory(config.name, { cwd: runCwd, requireStrong:forced||needsStrong, approvalContext:args.approval_context as string | undefined }) }
      : undefined;
    let decision = await evaluatePolicy(cmdArgs, compiled, approvalHook);
    // A strong-approval path runs only when this tool's policy routed it to approval.
    if(needsStrong && decision.ok && !('approval' in decision)) {
      decision={ok:false,rule:'hard_deny',message:'this operation requires a tool whose policy routes it to approval'};
    }
    // Evaluate normal policy first; no approval can override its hard denials.
    if(forced && decision.ok && !('approval' in decision)) {
      const verdict=await approvalHook?.fn({tool:config.name,argv:cmdArgs,rule:'approval_subcommands',matched:'breaker'});
      decision=verdict?.approved ? {ok:true,approval:{reserved_id:verdict.id}} : {ok:false,rule:'approval_subcommands',message:'breaker requires strong approval',... (verdict && 'id' in verdict ? {pending_approval:{id:verdict.id,expires_at:verdict.expires_at,payload:verdict.payload}} : {})};
    }
    try {
      if(!decision.ok && !decision.pending_approval)await injected.circuitBreaker?.securityDenial(currentCaller());
      else await injected.circuitBreaker?.record(currentCaller(),false);
    } catch {if(injected.circuitBreaker?.config.mode!=='observe'){if(decision.ok && 'approval' in decision)await safeHook(()=>injected.approvalSettler?.release(decision.approval.reserved_id),'release');return errorResult('breaker_unavailable');}}
    const policyEvent:PolicyDecisionEvent={
      tool: config.name,
      profile: currentCaller()?.profile ?? 'unknown',
      decision: decision.ok
        ? 'approval' in decision ? 'approved' : 'allow'
        : decision.pending_approval ? 'approval_required' : 'deny',
      rule: decision.ok ? ('approval' in decision ? 'approval' : 'none') : decision.rule,
    };
    injected.policyDecisionSink?.(policyEvent);
    try{injected.observationSink?.(policyEvent,cmdArgs,runCwd);}catch{/* observers never affect execution */}
    if (!decision.ok) {
      logger.warn('cli_passthrough policy deny', {
        tool: config.name,
        rule: decision.rule,
        argv_len: cmdArgs.length,
      });
      injected.auditSink?.({
        tool: config.name,
        decision: 'deny',
        rule: decision.rule,
        argv_len: cmdArgs.length,
      });
      injected.metricsSink?.({ tool: config.name, decision: 'deny', rule: decision.rule });
      if (decision.pending_approval) {
        const ttlSec = Math.max(0, Math.round((decision.pending_approval.expires_at - Date.now()) / 1000));
        return errorResult(
          `Approval required: ${JSON.stringify(decision.pending_approval.payload ?? {approval_id:decision.pending_approval.id})}. ` +
            `Retry the SAME argv within ${ttlSec}s after approval (approval id: ${decision.pending_approval.id}).`,
        );
      }
      return errorResult(`Denied by policy.${decision.rule}`);
    }
    if ('approval' in decision) {
      reservedId = decision.approval.reserved_id;
      logger.info('cli_passthrough approval bypass', {
        tool: config.name,
        approval_id: decision.approval.reserved_id,
        argv_len: cmdArgs.length,
      });
    }
    if (compiled.audit) {
      logger.info('cli_passthrough audit accept', {
        tool: config.name,
        argv_len: cmdArgs.length,
      });
    }
    // Audit-allow is emitted only when the tool config has audit:true.
    if (compiled.audit) {
      injected.auditSink?.({
        tool: config.name,
        decision: 'allow',
        argv_len: cmdArgs.length,
      });
    }
  }

  // __run spawns in the cwd resolved before the policy check (the same path the
  // approval is bound to); __help output is independent of cwd.
  const cwd = reviewed?.cwd ?? (kind === 'run' ? runCwd : undefined);

  const env = runEnv ?? buildRestrictedEnv(envRefs.map(envRefName));
  try {
    for (const ref of envRefs) {
      if (typeof ref === 'string') continue;
      delete env[ref.name];
      env[ref.name] = 'from' in ref
        ? await requireSecret(ref.from)
        : await resolveMintedCredential(ref.mint, {
            profile: caller?.profile ?? '',
            agent: caller?.agent ?? null,
            backend: config.name,
          });
    }
  } catch (err) {
    if (reservedId) await safeHook(settleHooks(reservedId, currentCaller()).onPreSpawnError, 'release');
    const code = err instanceof Error ? err.message : '';
    // Credential-broker failures are already codes; vault/secret failures stay
    // collapsed to the historical single message.
    return errorResult(
      code === 'credential_unavailable' || code === 'unknown_credential_provider' || code === 'credential_identity_missing'
        ? code
        : 'vault_unavailable',
    );
  }
  // The declared KUBECONFIG, as resolved for this call (vault: refs and env
  // values that changed after load are only visible here). Never echo it.
  if (kubeconfigIsRelative(env[KUBECONFIG_VAR])) {
    if (reservedId) await safeHook(settleHooks(reservedId, currentCaller()).onPreSpawnError, 'release');
    return errorResult(KUBECONFIG_RELATIVE_MESSAGE);
  }
  const hooks = reservedId ? settleHooks(reservedId, currentCaller()) : {};
  let spawned = false, resultSettled = false;
  const onSpawn = hooks.onSpawn;
  // The spawn listener cannot await, so keep the finalize promise: the
  // execution result is recorded only once the approval is consumed.
  let finalizing: Promise<void> = Promise.resolve();
  hooks.onSpawn = () => { spawned = true; finalizing = safeHook(onSpawn, 'finalize'); return finalizing; };
  const settleResult = async (success: boolean): Promise<void> => {
    if (!reservedId || !spawned || resultSettled) return;
    resultSettled = true;
    await finalizing;
    await safeHook(() => injected.approvalSettler?.executionResult?.(reservedId!,success), 'executionResult');
  };
  const t0 = Date.now();
  let isolatedHome: IsolatedHome | undefined;
  try {
    if (config.isolate_config !== false) {
      isolatedHome = createIsolatedHome(config.command);
      Object.assign(env, isolatedHome.env);
      env['GH_NO_EXTENSIONS'] = '1';
    }
    // Forced last, with or without isolation, over any declared value.
    Object.assign(env, toolEnvPins(config.command));
  } catch {
    await safeHook(hooks.onPreSpawnError, 'release');
    return errorResult('could not create an isolated config dir for this call');
  }
  try {
    if (reviewed?.signal.aborted) {
      await safeHook(hooks.onPreSpawnError, 'release');
      return errorResult('Code Mode replay cancelled before spawn');
    }
    const { stdout, stderr, exitCode } = await runProcess(config.command, cmdArgs, env, config.timeout_ms, cwd, hooks);
    if (kind === 'run') {
      injected.metricsSink?.({
        tool: config.name,
        decision: 'allow',
        duration_ms: Date.now() - t0,
      });
    }
    await settleResult(exitCode===0);
    const text = exitCode === 0 ? (stdout || stderr) : `Exit ${exitCode}: ${stderr || stdout}`;
    return { content: [{ type: 'text', text }], isError: exitCode !== 0 };
  } catch (err) {
    await settleResult(false);
    if (kind === 'run') {
      injected.metricsSink?.({
        tool: config.name,
        decision: 'allow',
        duration_ms: Date.now() - t0,
      });
    }
    return errorResult(err instanceof Error ? err.message : String(err));
  } finally {
    isolatedHome?.cleanup();
  }
}

/** Caller-facing message for a rejected argv: reason and position only. */
function argvErrorMessage(err: ArgvCanonicalizationError): string {
  switch (err.reason) {
    case 'not_array':
      return "'args' must be an array of strings";
    case 'not_string':
      return "all items in 'args' must be strings";
    case 'nul':
      return "'args' must not contain NUL characters";
    default:
      return `'args' rejected (${err.reason}${err.index === undefined ? '' : ` at position ${err.index}`})`;
  }
}

function errorResult(text: string): McpCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

interface SpawnHooks {
  /** The child process started; fires at most once. */
  onSpawn?: () => unknown;
  /** spawn() threw, or the child errored before it started. */
  onPreSpawnError?: () => unknown;
}

function settleHooks(id: string, caller: CallerIdentity | undefined): SpawnHooks {
  const settler = injected.approvalSettler;
  const breaker = injected.circuitBreaker;
  if (!settler) {
    // No settler wired: the reservation is left to expire (never refunded).
    logger.warn('approval reserved but no settler wired', { approval_id: id });
    return {};
  }
  return {
    // The commit point: the approval is spent, so it may now count as one
    // distinct recovery probe. A released reservation never reaches here, and
    // finalize is true at most once per id. If the probe write fails, safeHook
    // logs it and recovery is merely slower (fail closed).
    onSpawn: async () => {
      if (await settler.finalize(id) === true && breaker && await breaker.recoveryEligible(caller, id)) await breaker.approved(caller, id);
    },
    onPreSpawnError: () => settler.release(id),
  };
}

/** Run a hook from an event listener; an exception or rejection must never
 *  escape it. Event listeners may drop the returned promise: it never rejects. */
async function safeHook(fn: (() => unknown) | undefined, what: string): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch (err) {
    logger.error('approval settle failed', { what, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Whether `p` is a regular file the process may execute. */
function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the command the way spawn will (path relative to `cwd`, bare name
 *  via `pathVar`). Returns an error message, or null when it can be started. */
function checkCommand(command: string, pathVar: string, cwd: string): string | null {
  if (command.length === 0 || command.includes('\0')) return 'CLI command is invalid';
  if (command.includes('/')) {
    const full = isAbsolute(command) ? command : resolvePath(cwd, command);
    return isExecutableFile(full) ? null : `CLI command '${command}' is not executable`;
  }
  for (const dir of pathVar.split(delimiter)) {
    if (dir.length === 0) continue;
    const base = isAbsolute(dir) ? dir : resolvePath(cwd, dir);
    if (isExecutableFile(join(base, command))) return null;
  }
  return `CLI command '${command}' not found on PATH`;
}

function buildRestrictedEnv(declaredVars: string[]): NodeJS.ProcessEnv {
  // PATH and HOME must be forwarded so bare command names resolve (via PATH lookup) and tools
  // that read user config (gh, codex) can find their config dir. SPLICEDOCK_BIN is prepended to
  // PATH so self-installed binaries take precedence over anything shipped in the base image.
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

/** Resolve the working directory for __run to a symlink-free realpath, so the
 *  approval binding and the spawn use the same directory.
 *
 *  The caller's cwd lets workspace-aware tools (gh, codex, kubectl) resolve
 *  files, git context and local config. A caller in a DIFFERENT container may
 *  pass a path from its own filesystem that does not exist here; Node's spawn
 *  reports a missing cwd as `spawn <cmd> ENOENT`, indistinguishable from a
 *  missing binary. So a cwd that is not an existing directory is ignored and
 *  the process cwd is used, as before, but always in resolved form. */
function resolveRunCwd(raw: unknown): string {
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      if (statSync(raw).isDirectory()) return realpathSync(raw);
    } catch {
      // fall through to the process cwd
    }
  }
  return realpathSync(process.cwd());
}

function runProcess(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  cwd?: string,
  hooks: SpawnHooks = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd });
    } catch (err) {
      void safeHook(hooks.onPreSpawnError, 'release');
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let spawned = false;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.once('spawn', () => {
      spawned = true;
      void safeHook(hooks.onSpawn, 'finalize');
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    // A timeout before 'spawn' neither finalizes nor releases: the
    // reservation expires and is not refunded.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`CLI command '${command}' timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.on('close', (code) => {
      finish(() => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    });
    child.on('error', (err) => {
      if (!spawned) void safeHook(hooks.onPreSpawnError, 'release');
      finish(() => reject(err));
    });
  });
}
