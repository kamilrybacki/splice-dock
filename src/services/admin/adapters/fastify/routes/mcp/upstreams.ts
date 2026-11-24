import type { FastifyInstance } from 'fastify';
import { toolSchema } from '../../../../../../config/schema.js';
import type { McpProxyToolConfig } from '../../../../../../config/types.js';
import type { McpUpstreamManager } from '../../../../../upstreams/base.js';
import { isUpstreamHostAllowed } from '../../../../../upstreams/mcp/allowlist.js';
import type { InvalidationPublisher } from '../../../../../../contracts/outbound/invalidation/bus.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function err(reply: { code(n: number): { send(b: unknown): unknown } }, code: number, c: string, message: string, details?: unknown) {
  return reply.code(code).send({ error: { code: c, message, ...(details ? { details } : {}) } });
}

// Runtime MCP upstreams. YAML-declared upstreams are listed (source: 'file') but
// read-only here. New/edited hosts must match server.mcp_upstream_allowlist.
export function registerMcpUpstreamRoutes(
  app: FastifyInstance,
  manager: McpUpstreamManager,
  allowlist: readonly string[],
  invalidation?: InvalidationPublisher,
): void {
  app.get('/api/v1/mcp-upstreams', async () => ({
    data: manager.list().map((u) => ({ name: u.config.name, source: u.source, config: u.config })),
  }));

  const validate = (body: unknown, reply: Parameters<typeof err>[0]): McpProxyToolConfig | null => {
    const parsed = toolSchema.safeParse({ ...(body as object), type: 'mcp_proxy' });
    if (!parsed.success || parsed.data.type !== 'mcp_proxy') {
      err(reply, 422, 'validation_error', 'Invalid MCP upstream', parsed.success ? undefined : parsed.error.issues);
      return null;
    }
    const cfg = parsed.data;
    if (!NAME_RE.test(cfg.name)) {
      err(reply, 422, 'validation_error', 'name must be lowercase letters, digits, "-" or "_"');
      return null;
    }
    if (!isUpstreamHostAllowed(cfg.service_dns, allowlist)) {
      err(reply, 403, 'host_not_allowed', `Host '${cfg.service_dns}' is not in server.mcp_upstream_allowlist — add it to splicedock.yaml first`);
      return null;
    }
    return cfg;
  };

  app.post('/api/v1/mcp-upstreams', async (req, reply) => {
    const cfg = validate(req.body, reply);
    if (!cfg) return;
    if (manager.has(cfg.name)) return err(reply, 409, 'conflict', `Upstream '${cfg.name}' already exists`);
    await manager.upsert(cfg);
    await invalidation?.publish('tools', cfg.name);
    return reply.code(201).header('Location', `/api/v1/mcp-upstreams/${cfg.name}`).send({ data: { name: cfg.name, source: 'runtime', config: cfg } });
  });

  app.put<{ Params: { name: string } }>('/api/v1/mcp-upstreams/:name', async (req, reply) => {
    const { name } = req.params;
    if (manager.isFileDefined(name)) return err(reply, 409, 'conflict', `Upstream '${name}' is defined in splicedock.yaml and cannot be changed here`);
    if (!manager.has(name)) return err(reply, 404, 'not_found', `Upstream '${name}' not found`);
    const cfg = validate(req.body, reply);
    if (!cfg) return;
    if (cfg.name !== name) return err(reply, 400, 'bad_request', 'rename is not supported — delete and re-create instead');
    await manager.upsert(cfg);
    await invalidation?.publish('tools', name);
    return reply.send({ data: { name, source: 'runtime', config: cfg } });
  });

  app.delete<{ Params: { name: string } }>('/api/v1/mcp-upstreams/:name', async (req, reply) => {
    const { name } = req.params;
    if (manager.isFileDefined(name)) return err(reply, 409, 'conflict', `Upstream '${name}' is defined in splicedock.yaml and cannot be deleted here`);
    if (!(await manager.remove(name))) return err(reply, 404, 'not_found', `Upstream '${name}' not found`);
    await invalidation?.publish('tools', name);
    return reply.code(204).send();
  });
}
