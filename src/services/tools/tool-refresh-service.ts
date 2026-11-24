import type { Metrics } from '../../common/metrics.js';
import type { PodAddressResolver, UpstreamToolListerFactory } from '../../contracts/outbound/upstream-discovery.js';
import type { McpProxyToolConfig } from '../../config/types.js';
import type { ToolRegistry } from './tool-registry.js';

/** Minimal logger interface compatible with the project's custom logger. */
interface RefreshLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export class ToolRefreshService {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly configs: McpProxyToolConfig[],
    private readonly registry: Pick<ToolRegistry, 'replaceToolsForUpstream'>,
    private readonly resolver: PodAddressResolver,
    private readonly metrics: Pick<Metrics, 'refreshSuccess' | 'refreshFailures'>,
    private readonly logger: RefreshLogger,
    private readonly intervalMs: number,
    private readonly openUpstream: UpstreamToolListerFactory,
  ) {}

  /** Run a single discovery pass across all upstream configs. Safe to call at startup. */
  async probeOnce(): Promise<void> {
    await this.tick();
  }

  /** Discover one upstream now (used when an upstream is added or edited at runtime). */
  async refreshOne(cfg: McpProxyToolConfig): Promise<void> {
    await this.refreshUpstream(cfg);
  }

  /** Start the background refresh timer. */
  start(): void {
    this.timer = setInterval(
      () => { this.tick().catch(err => this.logger.warn('refresh_tick_failed', { error: err instanceof Error ? err.message : String(err) })); },
      this.intervalMs,
    );
  }

  /** Stop the background refresh timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const cfg of this.configs) {
        await this.refreshUpstream(cfg);
      }
    } finally {
      this.running = false;
    }
  }

  private async refreshUpstream(cfg: McpProxyToolConfig): Promise<void> {
    let ips: string[];
    try {
      ips = await this.resolver.resolve(cfg.service_dns);
    } catch {
      this.logger.warn('refresh_dns_failed', { upstream: cfg.name });
      this.metrics.refreshFailures.inc({ upstream: cfg.name });
      return;
    }

    if (ips.length === 0) {
      this.logger.warn('refresh_no_pods', { upstream: cfg.name });
      this.metrics.refreshFailures.inc({ upstream: cfg.name });
      return;
    }

    // Connect via the headless Service DNS so each refresh re-resolves to a live
    // pod (consistent with the call-path driver). `ips` above is just a liveness gate.
    const driver = this.openUpstream(cfg);
    try {
      await driver.connect();
      const tools = await driver.listTools();
      this.registry.replaceToolsForUpstream(cfg, tools);
      this.metrics.refreshSuccess.inc({ upstream: cfg.name });
      this.logger.info('refresh_ok', { upstream: cfg.name, tool_count: tools.length });
    } catch (err) {
      this.logger.warn('refresh_upstream_failed', { upstream: cfg.name, error: err instanceof Error ? err.message : String(err) });
      this.metrics.refreshFailures.inc({ upstream: cfg.name });
    } finally {
      await driver.disconnect().catch(() => {});
    }
  }
}
