import type { CliPassthroughToolConfig, McpProxyToolConfig, SplicedockConfig } from './config/types.js';
import { logger } from './common/logger.js';
import { installCliPassthroughTools } from './services/tools/adapters/cli/installer.js';
import { resolveAndInjectCliPassthroughEnv } from './services/secrets/adapters/env/cli.js';
import type { ToolRegistry } from './services/tools/registry.js';
import type { ToolService } from './services/tools/base.js';

type Tools = SplicedockConfig['tools'];

/** Resolves vault-referenced env, then probes/installs each declared CLI
 *  passthrough. Only tools that end up `available` are registered, so clients
 *  never see broken tools. */
export async function resolveAvailablePassthroughs(tools: Tools): Promise<ReadonlySet<string>> {
  const configs = tools.filter((t): t is CliPassthroughToolConfig => t.type === 'cli_passthrough');
  const available = new Set<string>();
  if (configs.length === 0) return available;
  // Env first: some install scripts need authenticated downloads (e.g. GH_TOKEN).
  const envStats = await resolveAndInjectCliPassthroughEnv(configs);
  logger.info('cli_passthrough env resolution summary', envStats);
  const results = await installCliPassthroughTools(configs);
  for (const result of results) if (result.status === 'available') available.add(result.name);
  logger.info('cli_passthrough availability summary', {
    total: results.length,
    available: results.filter(r => r.status === 'available').length,
    failed: results.filter(r => r.status === 'failed').length,
    available_tools: [...available].sort(),
  });
  return available;
}

export function proxyConfigsOf(tools: Tools): McpProxyToolConfig[] {
  return tools.filter((t): t is McpProxyToolConfig => t.type === 'mcp_proxy');
}

/** Registers the YAML-declared http, cli and (available) cli_passthrough tools. */
export function registerFileTools(
  tools: Tools,
  toolService: ToolService,
  toolRegistry: ToolRegistry,
  availablePassthroughs: ReadonlySet<string>,
): void {
  for (const toolConfig of tools) {
    if (toolConfig.type === 'http') {
      const mcpDef = toolService.buildMcpDefForHttpTool(toolConfig);
      toolRegistry.addFileTool({ id: mcpDef.name, driver: 'http', source: 'file', config: toolConfig, mcpDef });
    } else if (toolConfig.type === 'cli') {
      const mcpDef = toolService.buildMcpDefForCliTool(toolConfig);
      toolRegistry.addFileTool({ id: mcpDef.name, driver: 'cli', source: 'file', config: toolConfig, mcpDef });
    } else if (toolConfig.type === 'cli_passthrough') {
      if (!availablePassthroughs.has(toolConfig.name)) {
        logger.warn('skipping cli_passthrough registration — binary not available', { tool: toolConfig.name });
        continue;
      }
      for (const mcpDef of toolService.buildMcpDefsForCliPassthroughTool(toolConfig)) {
        toolRegistry.addFileTool({ id: mcpDef.name, driver: 'cli_passthrough', source: 'file', config: toolConfig, mcpDef });
      }
    }
  }
}
