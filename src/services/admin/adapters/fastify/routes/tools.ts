import type { FastifyInstance } from 'fastify';
import type { ToolRegistry, RegistryEntry } from '../../../../tools/registry.js';
import type { ToolDefinitions } from '../../../../tools/base.js';
import type { ToolConfig } from '../../../../../config/types.js';
import type { SplicedockStore } from '../../../../database/adapters/store.js';
import { toolSchema } from '../../../../../config/schema.js';
import { exportToolsYaml } from '../export/yaml.js';
import type { InvalidationPublisher } from '../../../../../contracts/outbound/invalidation/bus.js';

export function registerToolRoutes(
  app: FastifyInstance,
  toolRegistry: ToolRegistry,
  toolService: ToolDefinitions,
  // When provided, runtime http/cli tools are persisted so they survive a
  // pod restart. Omitted in lightweight test harnesses (in-memory only).
  store?: SplicedockStore,
  // Allowed bare command names for cli tools. When provided, the POST/PUT
  // handlers reject a cli tool whose command is not whitelisted, so the
  // operator learns at registration time rather than on a silent call-time deny.
  cliWhitelist?: readonly string[],
  // Announces committed writes so sibling replicas re-read the DB. Publish
  // happens after the write commits and never rejects.
  invalidation?: InvalidationPublisher,
): void {
  app.get('/api/v1/tools', async (req, reply) => {
    const format = (req.query as Record<string, string>)['format'];
    const source = (req.query as Record<string, string>)['source'];

    // Optional source filter. Runtime tools sort last in getAllTools(), so on a
    // deployment with >per_page file tools they fall off page 1 — the UI relies
    // on ?source=runtime to list UI-added tools reliably.
    if (source !== undefined && source !== 'file' && source !== 'runtime') {
      reply.code(400).send({ error: { code: 'bad_request', message: "source must be 'file' or 'runtime'" } });
      return;
    }
    const tools = source
      ? toolRegistry.getAllTools().filter(t => t.source === source)
      : toolRegistry.getAllTools();

    if (format === 'yaml') {
      reply.type('application/yaml').send(exportToolsYaml(tools));
      return;
    }

    const rawPage = parseInt((req.query as Record<string, string>)['page'] ?? '1', 10);
    const rawPerPage = parseInt((req.query as Record<string, string>)['per_page'] ?? '20', 10);
    if (!Number.isInteger(rawPage) || rawPage < 1 || !Number.isInteger(rawPerPage) || rawPerPage < 1) {
      reply.code(400).send({ error: { code: 'bad_request', message: 'page and per_page must be positive integers' } });
      return;
    }
    const page = rawPage;
    const perPage = Math.min(rawPerPage, 100);
    const start = (page - 1) * perPage;

    reply.send({
      data: tools.slice(start, start + perPage).map(toApiEntry),
      meta: { total: tools.length, page, per_page: perPage },
    });
  });

  app.get('/api/v1/tools/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const format = (req.query as Record<string, string>)['format'];
    const tool = toolRegistry.getTool(id);
    if (!tool) { reply.code(404).send({ error: { code: 'not_found', message: `Tool '${id}' not found` } }); return; }

    if (format === 'yaml') {
      reply.type('text/yaml').send(exportToolsYaml([tool]));
      return;
    }

    reply.send({ data: toApiEntry(tool) });
  });

  app.post('/api/v1/tools', async (req, reply) => {
    const parsed = toolSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ error: { code: 'validation_error', message: 'Invalid tool config', details: parsed.error.issues } });
      return;
    }

    const config = parsed.data as ToolConfig;

    if (config.type === 'mcp_proxy' || config.type === 'cli_passthrough') {
      return reply.code(400).send({ error: { code: 'bad_request', message: config.type === 'mcp_proxy' ? 'MCP upstreams are managed via /api/v1/mcp-upstreams (or the Add tool wizard → MCP server)' : 'cli_passthrough tools cannot be registered at runtime — add them to splicedock.yaml and restart' } });
    }

    const whitelistError = checkCliWhitelist(config, cliWhitelist);
    if (whitelistError) {
      return reply.code(400).send({ error: { code: 'bad_request', message: whitelistError } });
    }

    const id = buildId(config);

    if (toolRegistry.isFileDefined(id)) {
      reply.code(409).send({ error: { code: 'conflict', message: `Tool '${id}' is file-defined and cannot be overridden via API` } });
      return;
    }

    const mcpDef = config.type === 'http'
      ? toolService.buildMcpDefForHttpTool(config)
      : toolService.buildMcpDefForCliTool(config);

    const entry: RegistryEntry = { id, driver: config.type, source: 'runtime', config, mcpDef };
    // Persist first: if the store write throws (e.g. disk full) the request
    // fails 5xx with nothing registered, rather than a registry entry that
    // vanishes on restart. addRuntimeTool is an in-memory Map.set and won't throw.
    await store?.upsertRuntimeTool(id, config.type, config, 'admin-ui');
    toolRegistry.addRuntimeTool(entry);
    await invalidation?.publish('tools', id);

    reply.code(201).header('Location', `/api/v1/tools/${id}`).send({ data: toApiEntry(entry) });
  });

  app.put<{ Params: { id: string } }>('/api/v1/tools/:id', async (req, reply) => {
    const { id } = req.params;
    const parsed = toolSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: { code: 'validation_error', message: 'Invalid tool config', details: parsed.error.issues } });
    }
    const config = parsed.data as ToolConfig;
    if (config.type === 'mcp_proxy' || config.type === 'cli_passthrough') {
      return reply.code(400).send({ error: { code: 'bad_request', message: config.type === 'mcp_proxy' ? 'MCP upstreams are managed via /api/v1/mcp-upstreams (or the Add tool wizard → MCP server)' : 'cli_passthrough tools cannot be registered at runtime — add them to splicedock.yaml and restart' } });
    }
    const whitelistError = checkCliWhitelist(config, cliWhitelist);
    if (whitelistError) {
      return reply.code(400).send({ error: { code: 'bad_request', message: whitelistError } });
    }
    // Reject renames: the path id is the registry key + DB primary key. If the
    // body's namespace/name resolve to a different id, the tool would be keyed
    // under the path id but advertised to MCP clients under the body name —
    // inconsistent after reload. Rename = delete + re-create.
    if (buildId(config) !== id) {
      return reply.code(400).send({ error: { code: 'bad_request', message: `Body resolves to id '${buildId(config)}' but path is '${id}'; rename is not supported — delete and re-create instead` } });
    }
    const mcpDef = config.type === 'http'
      ? toolService.buildMcpDefForHttpTool(config)
      : toolService.buildMcpDefForCliTool(config);
    const updatedEntry: RegistryEntry = { id, driver: config.type, source: 'runtime', config, mcpDef };
    try {
      // updateRuntimeTool throws for not-found / file-defined ids BEFORE the
      // store write, so no phantom row is ever persisted.
      const entry = toolRegistry.updateRuntimeTool(id, updatedEntry);
      await store?.upsertRuntimeTool(id, config.type, config, 'admin-ui');
      await invalidation?.publish('tools', id);
      return reply.send({ data: toApiEntry(entry) });
    } catch (err: unknown) {
      return reply.code(400).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
  });

  app.delete('/api/v1/tools/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;

    // Not in the registry: it may still be an orphaned DB row (e.g. a malformed
    // config that failed to reload, or a tool later promoted to splicedock.yaml).
    // Prune it so it can't linger forever; 204 if we removed a row, else 404.
    if (!toolRegistry.getTool(id)) {
      const prunedRow = await store?.deleteRuntimeTool(id) ?? false;
      if (prunedRow) { await invalidation?.publish('tools', id); reply.code(204).send(); return; }
      reply.code(404).send({ error: { code: 'not_found', message: `Tool '${id}' not found` } });
      return;
    }

    if (toolRegistry.isFileDefined(id)) {
      // Can't delete the registry entry, but prune any orphaned runtime row
      // that was shadowed by the file definition on reload.
      if (await store?.deleteRuntimeTool(id)) await invalidation?.publish('tools', id);
      reply.code(409).send({ error: { code: 'conflict', message: `Tool '${id}' is file-defined and cannot be deleted` } });
      return;
    }
    // Delete the persisted row first: if it threw AFTER the registry removal,
    // the row would survive and resurrect the "deleted" tool on next restart.
    await store?.deleteRuntimeTool(id);
    toolRegistry.removeTool(id);
    await invalidation?.publish('tools', id);
    reply.code(204).send();
  });
}

/** Returns an error message if `config` is a cli tool whose command is not in
 *  the whitelist; null otherwise (or when no whitelist is supplied). */
function checkCliWhitelist(config: ToolConfig, cliWhitelist?: readonly string[]): string | null {
  if (config.type !== 'cli' || !cliWhitelist) return null;
  if (cliWhitelist.includes(config.command)) return null;
  return `Command '${config.command}' is not in the cli_whitelist — add it to server.cli_whitelist in splicedock.yaml first`;
}

function buildId(config: ToolConfig): string {
  if (config.type === 'mcp_proxy' || config.type === 'cli_passthrough') return config.name;
  return `${config.namespace}__${config.name}`;
}

function toApiEntry(e: RegistryEntry) {
  return { id: e.id, driver: e.driver, source: e.source, config: e.config };
}
