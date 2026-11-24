import type { Server } from 'node:http';
import { drainHttpServer } from './common/http/drain.js';
import { logger } from './common/logger.js';

// How long SIGTERM waits for in-flight MCP requests before force-closing them.
// Keep it below the pod's terminationGracePeriodSeconds minus the preStop sleep.
const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

export function drainTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = Number(env['SPLICEDOCK_DRAIN_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DRAIN_TIMEOUT_MS;
}

export interface ShutdownDeps {
  readonly mcpServer: Server;
  readonly drainTimeoutMs: number;
  /** Stopped in order after the MCP server has drained; the store goes last. */
  readonly stops: readonly (() => unknown | Promise<unknown>)[];
}

/** Graceful shutdown. Order matters with several replicas behind one Service:
 *  first stop taking MCP traffic and let in-flight calls finish (they still
 *  need the store), then the admin API, then background work, the store last. */
export function registerShutdown(deps: ShutdownDeps): void {
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      (async () => {
        logger.info('shutting down', { signal });
        const drain = await drainHttpServer(deps.mcpServer, deps.drainTimeoutMs);
        logger.info('mcp server drained', { result: drain });
        for (const stop of deps.stops) await stop();
      })().catch((err) => {
        logger.error('shutdown error', { error: err instanceof Error ? err.message : String(err) });
      }).finally(() => process.exit(0));
    });
  }
}
