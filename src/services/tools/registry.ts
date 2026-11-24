import type { ToolConfig } from '../../config/types.js';

import type { McpToolDef } from '../../contracts/internal/mcp/tool.js';
export type { McpToolDef } from '../../contracts/internal/mcp/tool.js';

export interface RegistryEntry {
  id: string;
  driver: 'mcp_proxy' | 'http' | 'cli' | 'cli_passthrough';
  source: 'file' | 'runtime';
  config: ToolConfig;
  mcpDef: McpToolDef;
}

export class ToolRegistry {
  private fileTools = new Map<string, RegistryEntry>();
  private runtimeTools = new Map<string, RegistryEntry>();
  private mutationCount = 0;

  /** Bumped on every runtime-set change; lets a resync detect a concurrent local write. */
  get mutations(): number { return this.mutationCount; }

  addFileTool(entry: RegistryEntry): void { this.fileTools.set(entry.id, entry); }
  addRuntimeTool(entry: RegistryEntry): void {
    this.mutationCount += 1;
    this.runtimeTools.set(entry.id, entry);
  }

  /** Swap the whole runtime set in one step (cross-replica resync): tools
   *  deleted on another replica disappear, readers never see a half-built map. */
  replaceRuntimeTools(entries: readonly RegistryEntry[]): void {
    this.mutationCount += 1;
    this.runtimeTools = new Map(entries.map((e) => [e.id, e] as const));
  }

  /** Updates an existing runtime tool. Throws if not found or if it is file-defined. */
  updateRuntimeTool(id: string, entry: RegistryEntry): RegistryEntry {
    if (this.fileTools.has(id)) {
      throw new Error(`Tool '${id}' is file-defined and cannot be updated via API`);
    }
    if (!this.runtimeTools.has(id)) {
      throw new Error(`Tool '${id}' not found`);
    }
    this.mutationCount += 1;
    this.runtimeTools.set(id, entry);
    return entry;
  }

  getTool(id: string): RegistryEntry | undefined {
    return this.runtimeTools.get(id) ?? this.fileTools.get(id);
  }

  getAllTools(): RegistryEntry[] {
    const merged = new Map<string, RegistryEntry>(this.fileTools);
    for (const [id, entry] of this.runtimeTools) merged.set(id, entry);
    return Array.from(merged.values());
  }

  /** Returns false (and does NOT remove) if the tool is file-defined. */
  removeTool(id: string): boolean {
    if (this.fileTools.has(id)) return false;
    this.mutationCount += 1;
    this.runtimeTools.delete(id);
    return true;
  }

  isFileDefined(id: string): boolean { return this.fileTools.has(id); }

  /**
   * Replace all file-defined mcp_proxy tools belonging to the given upstream config.
   * Removes existing entries whose id starts with `<config.name>__` and inserts the
   * new tool defs provided by the ToolRefreshService.
   */
  replaceToolsForUpstream(config: ToolConfig, tools: McpToolDef[]): void {
    this.removeUpstreamTools((config as { name: string }).name);
    for (const def of tools) {
      this.fileTools.set(def.name, {
        id: def.name,
        driver: 'mcp_proxy',
        source: 'file',
        config,
        mcpDef: def,
      });
    }
  }

  /** Drop every proxied tool discovered from the named upstream. */
  removeUpstreamTools(upstreamName: string): void {
    const prefix = `${upstreamName}__`;
    for (const [id, entry] of [...this.fileTools]) {
      if (entry.driver === 'mcp_proxy' && id.startsWith(prefix)) this.fileTools.delete(id);
    }
  }
}
