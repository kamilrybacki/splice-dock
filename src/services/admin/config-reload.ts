import type { SplicedockConfig } from '../../config/types.js';

/** What the reloader needs from each reconfigurable service. */
export interface ConfigReloadTargets {
  readonly breaker: { reconfigure(next: SplicedockConfig['server']['breaker']): Promise<void> };
  readonly shadow: { reconfigure(next: SplicedockConfig['server']['shadow']): void };
  readonly approvals: { reconfigureStrongTools(tools: readonly string[]): void };
}

export interface ConfigReloadLog {
  info(message: string): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ConfigReloader {
  /** Re-reads the full config and applies breaker, shadow and consent settings. Never throws. */
  reload(): Promise<void>;
}

/** The whole config is loaded and validated before any service is touched; a refusal leaves all unchanged. */
export function createConfigReloader(
  load: () => SplicedockConfig,
  targets: ConfigReloadTargets,
  log: ConfigReloadLog,
): ConfigReloader {
  return {
    async reload() {
      try {
        const next = load();
        await targets.breaker.reconfigure(next.server.breaker);
        targets.shadow.reconfigure(next.server.shadow);
        targets.approvals.reconfigureStrongTools(next.server.consent.strong_default_tools);
        log.info('breaker/shadow configuration reloaded');
      } catch (err) {
        log.warn('breaker/shadow reload refused', { error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
