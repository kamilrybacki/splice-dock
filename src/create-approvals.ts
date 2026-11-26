import type { SplicedockConfig } from './config/types.js';
import { approvalTtlMsFromEnv, grantsEnabledFromEnv, type Env } from './env-config.js';
import { logger } from './common/logger.js';
import { readGrantConfig } from './services/policy/grants/config.js';
import { builtinShapes } from './builtin-backends.js';
import { ApprovalService } from './services/approvals/base.js';
import { createPushNotifier, vapidFromEnv } from './services/approvals/adapters/push/web/notifier.js';
import { PushSubscriptionStore } from './services/database/adapters/push/store.js';
import type { SplicedockStore } from './services/database/adapters/store.js';
import type { PrometheusMetrics } from './services/metrics/adapters/prometheus/index.js';

export interface Approvals {
  readonly approvalService: ApprovalService;
  readonly pushStore: PushSubscriptionStore;
  readonly pushNotifier: ReturnType<typeof createPushNotifier> | undefined;
}

/** SQLite/Postgres-backed approval flow (on_violation: approval) plus optional web push. */
export function createApprovals(
  store: SplicedockStore,
  config: SplicedockConfig,
  metrics: PrometheusMetrics,
  env: Env,
): Approvals {
  const pushStore = new PushSubscriptionStore(store.consentDatabase());
  const vapid = vapidFromEnv(env);
  const pushNotifier = vapid ? createPushNotifier({ store: pushStore, vapid }) : undefined;
  logger.info(pushNotifier ? 'web push enabled' : 'web push disabled (no VAPID keys)');
  const grantConfig = readGrantConfig(env);
  if (env.SPLICEDOCK_GRANT_CONTEXT_MIN_SIM !== undefined) logger.warn('SPLICEDOCK_GRANT_CONTEXT_MIN_SIM is ignored: standing grants match on operation shape only (ADR 0009)');
  const consent = config.server.consent;
  const approvalService = new ApprovalService({
    store,
    grantsEnabled: grantsEnabledFromEnv(env),
    grantThreshold: grantConfig.threshold,
    grantExceptions: grantConfig.exceptions,
    shapes: builtinShapes,
    onGrantUsed: (tool, verb) => metrics.approvalGrantUsed.inc({ tool, verb }),
    ttlMs: approvalTtlMsFromEnv(env) ?? consent.approval_ttl_seconds * 1000,
    strongTools: consent.strong_default_tools,
    consentEnabled: consent.enabled,
    linkTtlMs: consent.link_ttl_seconds * 1000,
    consentOrigin: consent.enabled ? consent.origin : undefined,
    onConsentEvent: (level, event, latency) => {
      metrics.consent.inc({ level, event });
      if (latency !== undefined) metrics.consentLatency.observe({ level }, latency);
    },
    onEvent: (tool, event) => metrics.approvals.inc({ tool, event }),
    onRequested: pushNotifier ? info => { void pushNotifier.notify(info); } : undefined,
  });
  return { approvalService, pushStore, pushNotifier };
}
