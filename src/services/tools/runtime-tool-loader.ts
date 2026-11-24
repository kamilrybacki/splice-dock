// Re-register runtime-added (http/cli) tools from the persistent store into the
// in-memory ToolRegistry at startup, so UI/API-added tools survive a pod restart.
//
// File-defined tools always win: if a runtime tool's id collides with a
// file-defined one, the runtime row is skipped (and logged) — the operator
// presumably promoted it into splicedock.yaml.

import type { RuntimeToolRepository } from '../../contracts/outbound/repositories.js';
import type { ToolRegistry, RegistryEntry } from './tool-registry.js';
import type { ToolDefinitions } from './base.js';
import type { HttpToolConfig, CliToolConfig } from '../../config/types.js';
import { toolSchema } from '../../config/schema.js';
import type { LogFields } from '../../common/logger.js';

const RESYNC_MAX_ATTEMPTS = 3;

export interface RuntimeToolLoadSummary {
  loaded: number;
  skipped_file_collision: number;
  skipped_invalid: number;
}

interface LoaderLog {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
}

interface CollectedTools {
  entries: RegistryEntry[];
  summary: RuntimeToolLoadSummary;
}

/**
 * Read every persisted runtime tool and turn the valid ones into registry
 * entries. Resilience: every row is re-validated against the current
 * `toolSchema` and wrapped in a per-row try/catch. A single poisoned/stale row
 * (config drift, manual DB edit, command dropped from cli_whitelist) is
 * skipped — never allowed to throw out of here and crashloop the pod.
 */
async function collectRuntimeTools(
  store: RuntimeToolRepository,
  registry: ToolRegistry,
  toolService: ToolDefinitions,
  log: LoaderLog,
  cliWhitelist?: readonly string[],
): Promise<CollectedTools> {
  const summary: RuntimeToolLoadSummary = { loaded: 0, skipped_file_collision: 0, skipped_invalid: 0 };
  const entries: RegistryEntry[] = [];

  for (const row of await store.listRuntimeTools()) {
    // mcp_proxy upstream rows are owned by McpUpstreamManager, not this loader.
    if (row.driver === 'mcp_proxy') continue;
    if (registry.isFileDefined(row.id)) {
      summary.skipped_file_collision += 1;
      log.warn('runtime tool shadows a file-defined tool — skipping', { id: row.id });
      continue;
    }

    try {
      // Re-validate against the live schema — a row that was valid when written
      // may be shape-invalid after a config-type change. safeParse never throws.
      const parsed = toolSchema.safeParse(row.config);
      if (!parsed.success || (parsed.data.type !== 'http' && parsed.data.type !== 'cli')) {
        summary.skipped_invalid += 1;
        log.warn('runtime tool failed re-validation — skipping', { id: row.id, type: row.config.type });
        continue;
      }
      const config = parsed.data;

      if (config.type === 'cli' && cliWhitelist && !cliWhitelist.includes(config.command)) {
        summary.skipped_invalid += 1;
        log.warn('runtime cli tool command no longer whitelisted — skipping', { id: row.id, command: config.command });
        continue;
      }

      const mcpDef = config.type === 'http'
        ? toolService.buildMcpDefForHttpTool(config as HttpToolConfig)
        : toolService.buildMcpDefForCliTool(config as CliToolConfig);
      entries.push({ id: row.id, driver: config.type, source: 'runtime', config, mcpDef });
      summary.loaded += 1;
    } catch (err) {
      // Never let one bad row abort startup.
      summary.skipped_invalid += 1;
      log.warn('runtime tool reload threw — skipping', {
        id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { entries, summary };
}

/** Re-register persisted http/cli tools into the registry at startup (add-only). */
export async function loadRuntimeTools(
  store: RuntimeToolRepository,
  registry: ToolRegistry,
  toolService: ToolDefinitions,
  log: LoaderLog,
  cliWhitelist?: readonly string[],
): Promise<RuntimeToolLoadSummary> {
  const { entries, summary } = await collectRuntimeTools(store, registry, toolService, log, cliWhitelist);
  for (const entry of entries) registry.addRuntimeTool(entry);
  log.info('runtime tools reloaded', { ...summary });
  return summary;
}

/**
 * Cross-replica resync: make the registry's runtime set exactly mirror the DB,
 * including removing tools another replica deleted.
 */
export async function resyncRuntimeTools(
  store: RuntimeToolRepository,
  registry: ToolRegistry,
  toolService: ToolDefinitions,
  log: LoaderLog,
  cliWhitelist?: readonly string[],
): Promise<RuntimeToolLoadSummary> {
  for (let attempt = 0; attempt < RESYNC_MAX_ATTEMPTS; attempt += 1) {
    // A local admin write that commits after our SELECT would be wiped by the
    // whole-map swap, so re-read if the registry changed meanwhile.
    const before = registry.mutations;
    const { entries, summary } = await collectRuntimeTools(store, registry, toolService, log, cliWhitelist);
    if (registry.mutations !== before) continue;
    registry.replaceRuntimeTools(entries);
    log.info('runtime tools resynced', { ...summary });
    return summary;
  }
  // Writes kept racing the read: skip the swap; the local writer also publishes
  // an invalidation and the periodic reconcile will converge.
  log.warn('runtime tools resync skipped: concurrent local writes');
  return { loaded: 0, skipped_file_collision: 0, skipped_invalid: 0 };
}
