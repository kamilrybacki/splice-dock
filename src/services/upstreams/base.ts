// Owns the set of mcp_proxy upstreams: those declared in splicedock.yaml
// (immutable at runtime) and those created through the admin API/wizard
// (persisted in runtime_tools with driver 'mcp_proxy').
//
// `proxyConfigs` is the SAME array instance the MCP server resolves sessions
// against, so mutating it here takes effect without a restart.

import type { RuntimeToolRepository } from '../../contracts/outbound/repositories.js';
import type { McpProxyToolConfig } from '../../config/types.js';
import { toolSchema } from '../../config/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { LogFields } from '../../common/logger.js';

interface ManagerLog {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
}

export interface UpstreamView {
  config: McpProxyToolConfig;
  source: 'file' | 'runtime';
}

export class McpUpstreamManager {
  private readonly fileNames: ReadonlySet<string>;

  constructor(
    private readonly proxyConfigs: McpProxyToolConfig[],
    private readonly registry: Pick<ToolRegistry, 'removeUpstreamTools'>,
    private readonly refresher: { refreshOne(cfg: McpProxyToolConfig): Promise<void> },
    private readonly store: RuntimeToolRepository | undefined,
    private readonly log: ManagerLog,
  ) {
    this.fileNames = new Set(proxyConfigs.map((c) => c.name));
  }

  isFileDefined(name: string): boolean { return this.fileNames.has(name); }

  list(): UpstreamView[] {
    return this.proxyConfigs.map((config) => ({ config, source: this.isFileDefined(config.name) ? 'file' : 'runtime' }));
  }

  has(name: string): boolean { return this.proxyConfigs.some((c) => c.name === name); }

  /** Add or replace a runtime upstream, then discover its tools. */
  async upsert(config: McpProxyToolConfig, by: string | null = 'admin-ui'): Promise<void> {
    if (this.isFileDefined(config.name)) throw new Error(`Upstream '${config.name}' is defined in splicedock.yaml`);
    await this.store?.upsertRuntimeTool(config.name, 'mcp_proxy', config, by);
    this.apply(config);
    await this.refresher.refreshOne(config);
  }

  /** Remove a runtime upstream and every tool it contributed. */
  async remove(name: string): Promise<boolean> {
    if (this.isFileDefined(name)) throw new Error(`Upstream '${name}' is defined in splicedock.yaml`);
    const existed = (await this.store?.deleteRuntimeTool(name)) ?? false;
    const dropped = this.drop(name);
    return existed || dropped;
  }

  /** Startup/cross-replica: make the runtime upstream set mirror the DB rows. */
  async syncFromStore(): Promise<void> {
    if (!this.store) return;
    const wanted = new Map<string, McpProxyToolConfig>();
    for (const row of await this.store.listRuntimeTools()) {
      if (row.driver !== 'mcp_proxy') continue;
      const parsed = toolSchema.safeParse(row.config);
      if (!parsed.success || parsed.data.type !== 'mcp_proxy' || this.isFileDefined(parsed.data.name)) {
        this.log.warn('runtime mcp upstream skipped', { id: row.id });
        continue;
      }
      wanted.set(parsed.data.name, parsed.data);
    }
    for (const c of [...this.proxyConfigs]) {
      if (!this.isFileDefined(c.name) && !wanted.has(c.name)) this.drop(c.name);
    }
    for (const [name, cfg] of wanted) {
      const current = this.proxyConfigs.find((c) => c.name === name);
      if (current && JSON.stringify(current) === JSON.stringify(cfg)) continue;
      this.apply(cfg);
      await this.refresher.refreshOne(cfg);
    }
  }

  private apply(config: McpProxyToolConfig): void {
    const i = this.proxyConfigs.findIndex((c) => c.name === config.name);
    if (i >= 0) this.proxyConfigs[i] = config; else this.proxyConfigs.push(config);
  }

  private drop(name: string): boolean {
    const i = this.proxyConfigs.findIndex((c) => c.name === name);
    if (i < 0) return false;
    this.proxyConfigs.splice(i, 1);
    this.registry.removeUpstreamTools(name);
    return true;
  }
}
