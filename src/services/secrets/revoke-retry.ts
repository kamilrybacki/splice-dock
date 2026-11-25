import { logger } from '../../common/logger.js';

/** Retries after the first failed attempt, so a credential gets at most 1 + this many tries. */
export const REVOKE_RETRY_MAX_ATTEMPTS = 5;
/** Wait before the first retry; doubles on each further one. */
export const REVOKE_RETRY_BASE_MS = 2_000;
/** Ceiling for the wait between two retries. */
export const REVOKE_RETRY_MAX_MS = 60_000;

/** Non-secret labels for log lines; never the credential. */
export interface RevokeRetryInfo {
  readonly provider: string;
  readonly profile: string;
  /** What is being retried when it is not a single provider revoke, e.g. a store cleanup. */
  readonly operation?: string;
}

/**
 * Runs a provider revoke again, in the background, after its first attempt failed.
 * In-process only: timers are unref'd so they never hold the process open, `close()`
 * cancels every pending one, and a retry that is still failing after the budget is
 * logged once and dropped. Nothing here is ever awaited by a caller.
 */
export class RevokeRetrier {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  /** Schedule the first retry of `attempt`, which just failed once. */
  retry(attempt: () => Promise<void>, info: RevokeRetryInfo): void {
    this.schedule(attempt, info, 1);
  }

  /** Cancel pending retries and refuse new ones. Idempotent. */
  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(attempt: () => Promise<void>, info: RevokeRetryInfo, retryNumber: number): void {
    if (this.closed) return;
    const delay = Math.min(REVOKE_RETRY_MAX_MS, REVOKE_RETRY_BASE_MS * 2 ** (retryNumber - 1));
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.run(attempt, info, retryNumber);
    }, delay);
    timer.unref();
    this.timers.add(timer);
  }

  private async run(attempt: () => Promise<void>, info: RevokeRetryInfo, retryNumber: number): Promise<void> {
    try {
      await attempt();
      logger.info('credential provider revoke succeeded on retry', { ...info, attempts: retryNumber + 1 });
    } catch {
      // The provider's error text may echo what it was asked to revoke, so it is not logged.
      if (retryNumber >= REVOKE_RETRY_MAX_ATTEMPTS) {
        logger.warn('credential provider revoke abandoned', { ...info, attempts: retryNumber + 1 });
        return;
      }
      this.schedule(attempt, info, retryNumber + 1);
    }
  }
}
