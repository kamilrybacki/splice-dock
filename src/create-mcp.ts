import { createServer, type Server } from 'node:http';
import type { McpProxyToolConfig, SplicedockConfig } from './config/types.js';
import { createMcpExpressApp } from './services/mcp/adapters/express/server.js';
import type { SplicedockStore } from './services/database/adapters/store.js';
import { hashProfileToken } from './services/authentication/base.js';
import type { PrometheusMetrics } from './services/metrics/adapters/prometheus/index.js';
import type { ProfileService } from './services/profiles/base.js';
import type { ToolRegistry } from './services/tools/registry.js';
import type { PodResolver } from './services/upstreams/adapters/dns/pods.js';

export interface McpDeps {
  readonly config: SplicedockConfig;
  readonly profileService: ProfileService;
  readonly toolRegistry: ToolRegistry;
  readonly proxyConfigs: McpProxyToolConfig[];
  readonly podResolver: PodResolver;
  readonly metrics: PrometheusMetrics;
  readonly store: SplicedockStore;
  readonly authFor: (profile: string, backend: string) => McpProxyToolConfig['auth'] | undefined;
}

/** The MCP SSE entry adapter. Not listening yet: the caller starts it once
 *  the catalog and the policy and approval hooks are ready. */
export function createMcpServer(deps: McpDeps): Server {
  const { config, store } = deps;
  const app = createMcpExpressApp(
    deps.profileService,
    deps.toolRegistry,
    new Map(), // shared map is empty; drivers are allocated per-session
    config.server.cli_whitelist,
    {
      proxyConfigs: deps.proxyConfigs,
      resolver: deps.podResolver,
      metrics: deps.metrics,
      requireProfileToken: config.server.require_profile_token,
      // A `Authorization: Bearer <profile-token>` binds the session to that
      // token's profile; `?profile=` is then ignored. Unknown bearer -> 401.
      lookupProfileByToken: rawToken => store.findProfileByToken(hashProfileToken(rawToken), Date.now()),
      profileAuth: deps.authFor,
    },
  );
  return createServer(app);
}
