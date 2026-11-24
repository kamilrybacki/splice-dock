import type { CliPassthroughToolConfig } from '../../../../config/types.js';
import { resolveAuthValue } from '../vault/resolver.js';
import { logger } from '../../../../common/logger.js';

/**
 * Startup credential delivery for installers. Runtime calls resolve references again;
 * failure clears any previous injected credential and never retains stale data.
 */
export async function resolveAndInjectCliPassthroughEnv(
  configs: CliPassthroughToolConfig[],
): Promise<{ resolved: number; failed: number; skipped: number }> {
  const stats = { resolved: 0, failed: 0, skipped: 0 };
  const refs: Array<{ tool: string; name: string; from: string }> = [];

  for (const config of configs) {
    for (const ref of config.env) {
      if (typeof ref === 'string') {
        stats.skipped++;
        continue;
      }
      // Tool-level env is resolved at startup, without a profile identity, so a
      // mint binding cannot be honoured here. The loader rejects it; skip defensively.
      if (!('from' in ref)) {
        stats.skipped++;
        continue;
      }
      refs.push({ tool: config.name, name: ref.name, from: ref.from });
    }
  }

  if (refs.length === 0) return stats;

  // Parallel — each tool's secrets are independent.
  await Promise.all(
    refs.map(async ({ tool, name, from }) => {
      try {
        const value = await resolveAuthValue(from);
        process.env[name] = value;
        stats.resolved++;
        logger.info('resolved cli_passthrough env var', { tool, env_var: name });
      } catch (err) {
        delete process.env[name];
        stats.failed++;
        logger.warn('failed to resolve cli_passthrough env var', {
          tool,
          env_var: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  return stats;
}
