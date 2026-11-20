import type { Metrics } from '../../common/metrics.js';
let metrics: Metrics | undefined;
export function setLifecycleMetrics(value: Metrics): void { metrics = value; }
export function tokenEvent(event: string): void { metrics?.tokenLifecycle.inc({ event }); }
export function authEvent(result: string): void { metrics?.auth.inc({ result }); }
export function vaultEvent(outcome: string): void {
  metrics?.vaultRequests.inc({ outcome });
  metrics?.failclosedActive.set(outcome === 'ok' ? 0 : 1);
}
