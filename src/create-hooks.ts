import type { ToolHooks } from './services/tools/hooks.js';
import type { CircuitBreaker } from './services/policy/breaker/index.js';
import type { ShadowObserver } from './services/shadow/base.js';
import type { ApprovalService } from './services/approvals/base.js';
import type { AuditBuffer } from './services/audit/base.js';
import type { ToolMetrics } from './services/metrics/base.js';
import type { PolicyStore } from './services/policy/base.js';
import type { PrometheusMetrics } from './services/metrics/adapters/prometheus/index.js';
import type { CliPassthroughToolConfig } from './config/types.js';
import { builtinCliProfiles } from './builtin-backends.js';

export interface ToolHooksDeps {
  readonly policyStore: PolicyStore;
  readonly auditBuffer: AuditBuffer;
  readonly toolMetrics: ToolMetrics;
  readonly metrics: PrometheusMetrics;
  readonly shadow: ShadowObserver;
  readonly breaker: CircuitBreaker;
  readonly approvalService: ApprovalService;
  readonly profileEnvFor: (tool: string, profile: string) => CliPassthroughToolConfig['env'] | undefined;
}

/** Everything the CLI passthrough consults per call: the policy override
 *  store, audit/metrics/shadow sinks, the breaker and the approval flow. */
export function createToolHooks(deps: ToolHooksDeps): ToolHooks {
  const { approvalService, auditBuffer, toolMetrics, metrics, shadow, policyStore } = deps;
  return {
    effectivePolicyResolver: (cfg, profile) => policyStore.effective(cfg, profile),
    auditSink: entry => auditBuffer.push({ ...entry, ts: Date.now() }),
    metricsSink: entry => toolMetrics.record(entry),
    observationSink: (e, argv, cwd) => shadow.submit({ tool: e.tool, profile: e.profile, argv, cwd }, e.decision),
    policyDecisionSink: e => metrics.policyDecisions.inc(e as unknown as Record<string, string>),
    circuitBreaker: deps.breaker,
    approvalHookFactory: (tool, { cwd, requireStrong, approvalContext }) =>
      approvalService.makeHook(tool, cwd, undefined, requireStrong, approvalContext),
    approvalSettler: approvalService,
    profileEnvResolver: deps.profileEnvFor,
    cliProfiles: builtinCliProfiles,
  };
}
