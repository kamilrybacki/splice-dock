import type { ProfileTokenRepository } from '../../../contracts/outbound/repositories.js';
import type { SplicedockConfig } from '../../../config/schema.js';
import type { Metrics } from '../../../common/metrics.js';
import { logger } from '../../../common/logger.js';
import { runSweepExclusive } from '../../database/sweep/lock.js';
/** Returns cleanup so shutdown cannot sweep a closed database. No legacy-query row exists. */
export function startTokenSweep(store: ProfileTokenRepository, policy: SplicedockConfig['server']['token_policy'], metrics: Metrics): () => void {
  store.configureTokenTouch(policy.touch_interval_seconds);
  const sweep = async () => {
    // One replica sweeps per tick; the rest skip (no double revoke counts/logs).
    const result = await runSweepExclusive(store.consentDatabase(), 'tokenInactivity',
      () => store.sweepInactiveTokens(Date.now(), policy.inactivity_mode, policy.inactivity_days));
    if (!result) return;
    metrics.tokenLifecycle.inc({ event: 'revoked_inactive' }, result.revoked);
    metrics.tokenLifecycle.inc({ event: 'would_revoke_inactive' }, result.wouldRevoke);
    logger.info('token inactivity sweep', { mode: policy.inactivity_mode, ...result });
  };
  metrics.setActiveTokenCollector(async () => (await store.listProfileTokens()).filter(t => t.revoked_at === null && (t.expires_at === null || t.expires_at > Date.now())).length);
  const timer = setInterval(() => {
    sweep().catch(err => logger.warn('token inactivity sweep failed', { err: String(err) }));
  }, policy.sweep_interval_seconds * 1000);
  timer.unref();
  return () => { clearInterval(timer); metrics.setActiveTokenCollector(() => 0); };
}
