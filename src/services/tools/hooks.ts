import type { CliPassthroughToolConfig, CliToolPolicy } from '../../config/types.js';
import type { CircuitBreaker } from '../policy/breaker/index.js';
import type { ApprovalHook } from '../policy/cli/rules.js';

/** When a PolicyStore is wired (admin webui mode) it provides the effective
 *  policy per call; absent, the config's own `policy` field is used. */
export type EffectivePolicyResolver = (config: CliPassthroughToolConfig, profile?: string) => CliToolPolicy | undefined | Promise<CliToolPolicy | undefined>;

/** Sinks never receive argv content: only tool, rule id, decision and argv length. */
export type AuditSink = (entry: {
  tool: string;
  decision: 'allow' | 'deny';
  rule?: string;
  argv_len: number;
}) => void;

export type MetricsSink = (args: {
  tool: string;
  decision: 'allow' | 'deny';
  rule?: string;
  duration_ms?: number;
}) => void;

export interface PolicyDecisionEvent {
  tool: string;
  profile: string;
  decision: 'allow' | 'deny' | 'approval_required' | 'approved';
  /** Rule CATEGORY only (never argv values); 'none' for plain allow, 'approval' when an approval was reserved. */
  rule: string;
}

export type ObservationSink = (e: PolicyDecisionEvent, argv: readonly string[], cwd: string) => void;

/** `ctx.cwd` is the realpath of the directory the command will be spawned in;
 *  approvals are bound to it. */
export type ApprovalHookFactory = (toolName: string, ctx: { cwd: string; requireStrong?: boolean; approvalContext?: string }) => ApprovalHook;

/** Settles a reservation made by the approval hook: `finalize` once the child
 *  process has spawned (the approval is spent, whatever the exit code),
 *  `release` only after a confirmed pre-spawn failure. Unsettled reservations
 *  expire in the approval service and are never refunded. A half-open breaker
 *  counts a recovery probe only on a successful `finalize`, never on reserve. */
export interface ApprovalSettler {
  /** True only for the one call that moved the reservation to consumed. */
  finalize(id: string): Promise<boolean>;
  release(id: string): Promise<unknown>;
  executionResult?(id: string, success: boolean): Promise<void>;
}

/** Profile-scoped env refs (config: profiles.<name>.credentials.<tool>.env).
 *  Absent means every profile uses the tool's own `env`. */
export type ProfileEnvResolver = (tool: string, profile: string) => CliPassthroughToolConfig['env'] | undefined;

/** Everything the CLI passthrough needs from the outside. Every field is
 *  optional: an absent hook means the built-in default (no override, no sink). */
export interface ToolHooks {
  readonly effectivePolicyResolver?: EffectivePolicyResolver;
  readonly auditSink?: AuditSink;
  readonly metricsSink?: MetricsSink;
  readonly observationSink?: ObservationSink;
  readonly policyDecisionSink?: (e: PolicyDecisionEvent) => void;
  readonly circuitBreaker?: CircuitBreaker;
  readonly approvalHookFactory?: ApprovalHookFactory;
  readonly approvalSettler?: ApprovalSettler;
  readonly profileEnvResolver?: ProfileEnvResolver;
}
