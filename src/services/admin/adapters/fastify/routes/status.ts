import type { FastifyInstance } from 'fastify';
import { proxyDriverNamespace } from '../../../../upstreams/adapters/mcp/driver.js';
import type { McpProxyDriver } from '../../../../upstreams/adapters/mcp/driver.js';
import type { ToolRegistry } from '../../../../tools/tool-registry.js';

export function registerStatusRoutes(
  app: FastifyInstance,
  toolRegistry: ToolRegistry,
  proxyDrivers: Map<string, McpProxyDriver>,
): void {
  app.get('/api/v1/status', async (_req, reply) => {
    const tools = toolRegistry.getAllTools();
    const counts = { mcp_proxy: 0, http: 0, cli: 0, cli_passthrough: 0 };
    for (const t of tools) counts[t.driver]++;

    reply.send({
      data: {
        tool_count: tools.length,
        by_driver: counts,
        // One entry per backend: a per-profile credential opens a second,
        // profile-scoped connection with its own cache key.
        upstreams: Array.from(new Set(Array.from(proxyDrivers.keys(), proxyDriverNamespace))),
      },
    });
  });
}
