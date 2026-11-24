import type { SplicedockConfig } from './config/types.js';
import type { Env } from './env-config.js';
import { shadowKillSwitchFromEnv } from './env-config.js';
import { CircuitBreaker } from './services/policy/breaker/index.js';
import { builtinReadonlyProbes } from './services/policy/builtin.js';
import { ShadowObserver } from './services/shadow/base.js';
import type { SplicedockStore } from './services/database/adapters/store.js';
import type { PrometheusMetrics } from './services/metrics/adapters/prometheus/index.js';

const BREAKER_STATE_LEVEL = { open: 2, half_open: 1 } as const;

export async function createShadow(
  store: SplicedockStore,
  config: SplicedockConfig,
  metrics: PrometheusMetrics,
  env: Env,
): Promise<ShadowObserver> {
  const shadow = await ShadowObserver.create(
    store.consentDatabase(),
    config.server.shadow,
    undefined,
    (outcome, latency, depth, agreement) => {
      metrics.shadowTotal.inc({ outcome });
      metrics.shadowLatency.observe(latency / 1000);
      metrics.shadowDepth.set(depth);
      if (agreement) metrics.shadowAgreement.inc({ result: agreement });
    },
    () => shadowKillSwitchFromEnv(env),
  );
  metrics.setShadowPSICollector(() => shadow.psi());
  return shadow;
}

export function createBreaker(
  store: SplicedockStore,
  config: SplicedockConfig,
  metrics: PrometheusMetrics,
): Promise<CircuitBreaker> {
  return CircuitBreaker.create(
    store.consentDatabase(),
    config.server.breaker,
    (event, family, state) => {
      metrics.breakerEvents.inc({ event, scope: family });
      if (event === 'would_trip') metrics.breakerWouldTrip.inc({ scope: family });
      if (event === 'forced') {
        metrics.breakerForced.inc({ scope: family });
        metrics.breakerEscalations.inc();
      }
      if (state) {
        metrics.breakerTransitions.inc({ scope: family, to: state });
        metrics.breakerState.set({ scope: family }, state === 'open' || state === 'half_open' ? BREAKER_STATE_LEVEL[state] : 0);
      }
    },
    builtinReadonlyProbes,
  );
}
