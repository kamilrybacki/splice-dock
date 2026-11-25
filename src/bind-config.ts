import type { ListenOptions } from 'node:net';
import { logger } from './common/logger.js';
import type { SplicedockConfig } from './config/schema.js';

type ServerConfig = SplicedockConfig['server'];

/** Where the admin API listens. `admin_host` defaults to every interface. */
export function adminListenOptions(server: Pick<ServerConfig, 'admin_port' | 'admin_host'>): ListenOptions {
  return { port: server.admin_port, host: server.admin_host };
}

/** Where the MCP endpoint listens. With no `host`, Node's default (every interface) applies. */
export function mcpListenOptions(server: Pick<ServerConfig, 'port' | 'host'>): ListenOptions {
  return server.host === undefined ? { port: server.port } : { port: server.port, host: server.host };
}

/** `require_profile_token` defaults to true, so false can only be an explicit opt-out. */
export function warnIfProfileTokenOptional(server: Pick<ServerConfig, 'require_profile_token'>): void {
  if (server.require_profile_token) return;
  logger.warn(
    'server.require_profile_token is false: POST /mcp accepts the unauthenticated ?profile= selection. Set it to true and use profile tokens.',
  );
}
