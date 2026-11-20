import { createServer } from 'node:http';
import { ToolRegistry } from '../../src/application/registry/tool-registry.js';
import { ProfileRegistry } from '../../src/application/registry/profile-registry.js';
import { ToolService } from '../../src/application/tools/tool-service.js';
import { ProfileService } from '../../src/application/profiles/profile-service.js';
import { createMcpExpressApp } from '../../src/adapters/inbound/mcp/server.js';
import { createAdminServer } from '../../src/adapters/inbound/admin/server.js';
import type { McpProxyDriver } from '../../src/adapters/outbound/drivers/mcp-proxy.js';
import type { SplicedockConfig } from '../../src/config/schema.js';

export interface Harness {
  toolRegistry: ToolRegistry;
  profileRegistry: ProfileRegistry;
  adminApp: Awaited<ReturnType<typeof createAdminServer>>;
  mcpServer: ReturnType<typeof createServer>;
  mcpPort: number;
  adminPort: number;
  adminToken: string;
  teardown(): Promise<void>;
}

export interface HarnessOptions {
  config?: Partial<SplicedockConfig>;
  proxyDrivers?: Map<string, McpProxyDriver>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { config: partial = {}, proxyDrivers = new Map() } = options;
  const adminToken = 'test-admin-token';
  process.env['SPLICEDOCK_ADMIN_TOKEN'] = adminToken;

  const config: SplicedockConfig = {
    server: { port: 0, admin_port: 0, admin_token_env: 'SPLICEDOCK_ADMIN_TOKEN', cli_whitelist: ['echo'], ...partial.server },
    profiles: partial.profiles ?? {},
    tools: partial.tools ?? [],
  };

  const toolRegistry = new ToolRegistry();
  const profileRegistry = new ProfileRegistry();
  const toolService = new ToolService(toolRegistry);
  const profileService = new ProfileService(profileRegistry, toolRegistry);

  const mcpApp = createMcpExpressApp(profileService, toolRegistry, proxyDrivers, config.server.cli_whitelist);
  const mcpServer = createServer(mcpApp);
  await new Promise<void>(resolve => mcpServer.listen(0, '127.0.0.1', resolve));
  const mcpPort = (mcpServer.address() as { port: number }).port;

  const adminApp = await createAdminServer(toolRegistry, profileRegistry, toolService, profileService, proxyDrivers, config);
  await adminApp.listen({ port: 0, host: '127.0.0.1' });
  const adminPort = (adminApp.server.address() as { port: number }).port;

  return {
    toolRegistry,
    profileRegistry,
    adminApp,
    mcpServer,
    mcpPort,
    adminPort,
    adminToken,
    async teardown() {
      mcpServer.close();
      await adminApp.close();
      delete process.env['SPLICEDOCK_ADMIN_TOKEN'];
    },
  };
}
