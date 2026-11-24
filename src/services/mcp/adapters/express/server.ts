import type { OperationExchange } from '../../../../contracts/outbound/operation/exchange.js';
import { codeModeDef } from '../../../code-mode/base.js';
import { executeCode } from '../../../code-mode/adapters/quickjs/executor.js';
import {
  APPROVAL_WAIT_TOOL, approvalWaitTool, builtinTool, listedBuiltinTools, registerBuiltinTool,
  unregisterBuiltinTool, type ApprovalWaitHandler,
} from './tools/builtin.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../../../../contracts/outbound/tool-result.js';
import type { ProfileAccess } from '../../../profiles/base.js';
import type { ToolRegistry } from '../../../tools/registry.js';
import { McpProxyDriver, proxyDriverKey } from '../../../upstreams/adapters/mcp/driver.js';
import { executeWithPreflight } from '../../../code-mode/preflight.js';
import { localPreflightServices } from '../../../code-mode/adapters/http/preflight.js';
import { callHttpTool, type HttpExchange } from '../../../tools/adapters/http/driver.js';
import { callCliTool } from '../../../tools/adapters/cli/static.js';
import { callCliPassthrough, callReviewedCliPassthrough } from '../../../tools/adapters/cli/passthrough.js';
import { logger } from '../../../../common/logger.js';
import { PACKAGE_VERSION } from '../../../../common/version.js';
import { createQueryFallbackWarner, type ProfileSelectionSource } from './profiles/selection.js';
import { randomUUID } from 'node:crypto';
import type { HttpToolConfig, CliToolConfig, CliPassthroughToolConfig, McpProxyToolConfig } from '../../../../config/types.js';
import type { PodResolver } from '../../../upstreams/adapters/dns/pods.js';
import type { MetricsPort } from '../../../../contracts/outbound/metrics.js';
import { resolveBoundProfile, type ProfileTokenLookup } from '../../base.js';
import { clientLogFields } from './client/info.js';
import { LEGACY_QUERY_TOKEN_ID, currentCaller, runWithCaller } from '../../../../common/request/context.js';

/** Install (or, with undefined, remove) the approvals__wait built-in. */
export function setApprovalWaitHandler(handler: ApprovalWaitHandler | undefined): void {
  if (handler) registerBuiltinTool(approvalWaitTool(handler));
  else unregisterBuiltinTool(APPROVAL_WAIT_TOOL);
}

type DriverMap = Map<string, McpProxyDriver>;

/** Strip non-printable and control characters to prevent log injection. */
function sanitizeForLog(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '');
}

/**
 * Build a fresh MCP Server for a single SSE connection.
 * A new instance is created per connection to maintain per-session isolation.
 */
export function buildMcpServer(
  profile: string,
  profileService: ProfileAccess,
  proxyDrivers: DriverMap,
  toolRegistry?: ToolRegistry,
  cliWhitelist: string[] = [],
  proxyConfigs?: McpProxyToolConfig[],
  resolver?: PodResolver,
  agent?: string | null,
  userAgent?: string,
  /** Per-profile credential override for an mcp_proxy backend. undefined → use
   *  the tool-level credential every profile shares. */
  profileAuth?: (profile: string, backend: string) => McpProxyToolConfig['auth'] | undefined,
): Server {
  const server = new Server(
    { name: 'splicedock', version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  const isAllowed = (name: string): boolean => profileService.isToolAllowedForProfile(profile, name);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(profileService.isCodeModeEnabled(profile) ? [codeModeDef] : []),
      ...listedBuiltinTools('head', isAllowed),
      ...profileService.getToolsForProfile(profile),
      ...listedBuiltinTools('tail', isAllowed),
    ],
  }));

  const dispatch = async (toolName: string, rawArgs: Record<string, unknown>, signal?: AbortSignal, exchange?: HttpExchange, operation?: OperationExchange): Promise<ToolResult> => {
    const requestId = randomUUID().slice(0, 12);
    const safeName = sanitizeForLog(toolName);

    // Preserve native types (arrays, objects, numbers, booleans) for MCP proxy drivers.
    // Only stringify for legacy HTTP/CLI drivers that require string values.
    const stringArgs = Object.fromEntries(
      // Structured values (for `format: json` params) are serialised, not String()-ed to "[object Object]".
      Object.entries(rawArgs).map(([k, v]) => [k, typeof v === 'string' ? v : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)])
    );

    const builtin = builtinTool(toolName);
    // Built-ins are never registry-backed, so Code Mode preflight refuses them too.
    if (exchange && (builtin ||
        !['http', 'mcp_proxy', 'cli', 'cli_passthrough'].includes(toolRegistry?.getTool(toolName)?.driver ?? ''))) {
      return { content: [{ type: 'text', text: 'Code Mode preflight does not support this tool' }], isError: true };
    }

    if (builtin && !builtin.profileGated) return builtin.call(rawArgs, { signal });

    if (!profileService.isToolAllowedForProfile(profile, toolName)) {
      return {
        content: [{ type: 'text', text: `Tool '${safeName}' not found for profile '${profile}'` }],
        isError: true,
      } as ToolResult;
    }

    if (builtin) return builtin.call(rawArgs, { signal });

    // In production, toolRegistry is always provided; missing it is a misconfiguration.
    if (!toolRegistry) {
      logger.error('tool registry missing', { request_id: requestId, tool: safeName, profile });
      throw new Error('Tool registry is not available');
    }

    const entry = toolRegistry.getTool(toolName);
    if (!entry) {
      return { content: [{ type: 'text', text: `Tool '${safeName}' not registered` }], isError: true } as ToolResult;
    }

    const start = Date.now();
    try {
      if (entry.driver === 'mcp_proxy') {
        const namespace = toolName.split('__')[0];
        // A profile bound to its own credential cannot reuse the shared
        // connection: a driver carries one credential set, so mixing would send
        // this profile's calls under another identity. Key the cache by profile
        // for overrides; everyone else keeps the bare backend name.
        const overrideAuth = profileAuth?.(profile, namespace);
        const driverKey = proxyDriverKey(namespace, overrideAuth === undefined ? undefined : profile);
        let driver = proxyDrivers.get(driverKey);
        if (operation) {
          if (!driver || !signal) throw Error('No connected MCP upstream for guarded Code Mode');
          return driver.callReviewedTool(toolName, rawArgs, operation, signal);
        }
        if (!driver && proxyConfigs && resolver) {
          const cfg = proxyConfigs.find(c => c.name === namespace);
          if (cfg) {
            try {
              const ips = await resolver.resolve(cfg.service_dns);
              if (ips.length > 0) {
                // Connect via the headless Service DNS (NOT a pinned pod IP): the
                // driver re-resolves to a live pod on every (re)connect, so it
                // survives an upstream pod being replaced. Pinning a pod IP left
                // this shared, long-lived driver wedged after a redeploy/drain —
                // reconnect kept dialing the dead IP → "Proxy not connected".
                const newDriver = new McpProxyDriver(
                  overrideAuth === undefined ? cfg : { ...cfg, auth: overrideAuth },
                  undefined,
                  // Minted credentials are per profile/agent: the driver re-resolves
                  // auth on every request and needs to know whose credential to ask for.
                  { profile, agent: agent ?? null },
                );
                await newDriver.connect();
                proxyDrivers.set(driverKey, newDriver);
                driver = newDriver;
                logger.info('lazy upstream connect succeeded', { upstream: namespace, profile_scoped: overrideAuth !== undefined });
              }
            } catch (err) {
              logger.warn('lazy upstream connect failed', { upstream: namespace, error: err instanceof Error ? err.message : String(err) });
            }
          }
        }
        if (!driver) throw new Error(`No proxy driver for namespace '${namespace}'`);
        return await driver.callTool(toolName, rawArgs) as ToolResult;
      }

      if (entry.driver === 'http') {
        const httpConfig = entry.config as HttpToolConfig;
        const override = profileAuth?.(profile, httpConfig.name);
        return await callHttpTool(
          override === undefined ? httpConfig : { ...httpConfig, auth: override },
          stringArgs, exchange,
        ) as ToolResult;
      }

      if (entry.driver === 'cli') {
        return await callCliTool(entry.config as CliToolConfig, stringArgs, cliWhitelist, operation, signal) as ToolResult;
      }

      if (entry.driver === 'cli_passthrough') {
        // Route by tool-name suffix: `<name>__help` or `<name>__run`.
        const kind = toolName.endsWith('__help') ? 'help' : toolName.endsWith('__run') ? 'run' : null;
        if (!kind) {
          return { content: [{ type: 'text', text: `Unknown passthrough variant for '${safeName}'` }], isError: true } as ToolResult;
        }
        if (operation && signal) return callReviewedCliPassthrough(entry.config as CliPassthroughToolConfig, kind, rawArgs, cliWhitelist, operation, signal);
        return await callCliPassthrough(entry.config as CliPassthroughToolConfig, kind, rawArgs, cliWhitelist) as ToolResult;
      }

      return { content: [{ type: 'text', text: 'Unknown driver type' }], isError: true } as ToolResult;
    } finally {
      logger.info('tool call', {
        request_id: requestId,
        tool: safeName,
        profile,
        agent: agent ?? profile,
        ...clientLogFields(server.getClientVersion(), userAgent),
        driver: entry.driver,
        duration_ms: Date.now() - start,
      });
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    if (name === codeModeDef.name) {
      if (!profileService.isCodeModeEnabled(profile)) return { content: [{ type: 'text', text: 'Code Mode is disabled for this profile' }], isError: true };
      const mode = process.env.SPLICEDOCK_CODE_MODE_PREFLIGHT;
      const preflightProfiles = process.env.SPLICEDOCK_CODE_MODE_PREFLIGHT_PROFILES?.split(',').map(name => name.trim()) ?? [];
      if (mode !== undefined && preflightProfiles.includes(profile)) {
        const mock = process.env.SPLICEDOCK_CODE_MODE_MOCK_URL;
        const review = process.env.SPLICEDOCK_CODE_MODE_REVIEW_URL;
        const caller = currentCaller();
        if (!mock || !review || !caller?.authenticated || !['observe', 'enforce'].includes(mode)) {
          return { content: [{ type: 'text', text: 'Code Mode preflight requires an authenticated profile and configured local sidecars' }], isError: true };
        }
        return executeWithPreflight({
          executeCode,
          code: args.code as string,
          profile,
          catalog: () => profileService.getToolsForProfile(profile).filter(tool => ['http', 'mcp_proxy', 'cli', 'cli_passthrough'].includes(toolRegistry?.getTool(tool.name)?.driver ?? '')),
          dispatch: (tool, input, _phase, exchange, signal, operation) => dispatch(tool, input, signal, exchange, operation),
          services: localPreflightServices(mock, review),
          signal: extra?.signal,
          allowLive: mode === 'enforce',
        });
      }
      return executeCode(args.code as string, () => profileService.getToolsForProfile(profile), (tool, input) => dispatch(tool, input, extra?.signal), extra?.signal);
    }
    return dispatch(name, args, extra?.signal);
  });

  return server;
}

export interface McpExpressAppOptions {
  /** If provided, each SSE session allocates its own per-session proxy drivers (pinned pod IPs). */
  proxyConfigs?: McpProxyToolConfig[];
  /** Required when proxyConfigs is set — resolves service DNS to pod IPs. */
  resolver?: PodResolver;
  /** Optional metrics handle — increments session/connection counters when provided. */
  metrics?: MetricsPort;
  /**
   * When provided, a `Authorization: Bearer <profile-token>` on POST /mcp binds
   * the session to the profile this returns and the ?profile= query is ignored.
   * A bearer that resolves to null → 401. Absent/other auth → legacy ?profile=.
   */
  lookupProfileByToken?: ProfileTokenLookup;
  /**
   * When true, a valid profile-token bearer is mandatory: no/invalid bearer → 401
   * and ?profile= is ignored entirely. Default false (legacy ?profile= allowed).
   */
  requireProfileToken?: boolean;
  /**
   * Per-profile credential override for mcp_proxy backends, from the profile's
   * `credentials.<backend>.auth`. undefined → the backend's tool-level
   * credential, shared by every profile.
   */
  profileAuth?: (profile: string, backend: string) => McpProxyToolConfig['auth'] | undefined;
}

export function createMcpExpressApp(
  profileService: ProfileAccess,
  toolRegistry: ToolRegistry,
  proxyDrivers: DriverMap,
  cliWhitelist: string[],
  options: McpExpressAppOptions = {},
): express.Application {
  const { proxyConfigs, resolver, lookupProfileByToken, requireProfileToken = false, profileAuth } = options;
  const warnQueryFallback = createQueryFallbackWarner(profile =>
    logger.warn('profile selected via ?profile= query; use a profile token', { profile }),
  );
  const app = express();
  app.disable('x-powered-by');

  // Stateless Streamable HTTP endpoint — one server per request, no session to lose.
  // `sessionIdGenerator: undefined` disables session validation entirely, so this
  // route can never emit `session_not_found`; nothing is retained between requests,
  // so it survives pod restarts and scales across replicas. The legacy stateful
  // `/sse` + `/messages` transport was removed (2026-06-17) — its in-memory session
  // Map dropped sessions on any stream cut, and the client never re-initialised.
  app.post('/mcp', express.json(), async (req: Request, res: Response) => {
    // Bearer profile binding: a valid profile token binds the session to its
    // profile and the ?profile= query is ignored. An unknown bearer is 401 and
    // never falls back to the query — that fallback would be a self-escalation
    // hole (any caller could pick a more-privileged profile via ?profile=).
    let boundProfile: string | null = null;
    let tokenId: string = LEGACY_QUERY_TOKEN_ID;
    let agent: string | null = null;
    if (lookupProfileByToken) {
      const binding = await resolveBoundProfile(req.headers['authorization'], lookupProfileByToken);
      if (binding.unauthorized) {
        options.metrics?.profileSelection.inc({ source: 'none' });
        res.status(401).json({ error: 'invalid_profile_token' });
        return;
      }
      boundProfile = binding.profile;
      if (binding.tokenId) tokenId = binding.tokenId;
      agent = binding.agent ?? null;
    }
    if (requireProfileToken && !boundProfile) {
      options.metrics?.profileSelection.inc({ source: 'none' });
      res.status(401).json({ error: 'profile_token_required' });
      return;
    }
    const queryProfile = requireProfileToken ? undefined : req.query['profile'];
    const source: ProfileSelectionSource = boundProfile ? 'bearer' : queryProfile !== undefined ? 'query' : 'none';
    options.metrics?.profileSelection.inc({ source: source === 'query' ? 'legacy_query' : source });
    const rawProfile = boundProfile ?? String(queryProfile ?? 'default');
    const profile = /^[a-zA-Z0-9_-]{1,64}$/.test(rawProfile) ? rawProfile : 'default';
    if (source === 'query') {
      warnQueryFallback(profile);
      res.setHeader('Deprecation', '@' + Date.UTC(2026, 10, 18) / 1000);
      res.append('Link', '<https://kamilrybacki.github.io/splice-dock/connect.html#selection>; rel="deprecation"');
    }

    if (Array.isArray(req.body)) {
      res.status(400).json({ error: 'batch_not_supported' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(
      profile,
      profileService,
      proxyDrivers,
      toolRegistry,
      cliWhitelist,
      proxyConfigs,
      resolver,
      agent,
      req.headers['user-agent'],
      profileAuth,
    );
    // Closing the HTTP response must abort SDK request handlers, including waits.
    const onDisconnect = () => { void server.close().catch(logCloseFailure); };
    res.once('close', onDisconnect);
    try {
      await server.connect(transport);
      const authenticated = boundProfile !== null && tokenId !== LEGACY_QUERY_TOKEN_ID;
      await runWithCaller({ profile, tokenId, authenticated, agent }, () => transport.handleRequest(req, res, req.body));
    } finally {
      server.close().catch(logCloseFailure);
    }
  });

  // The gateway is stateless: it offers no SSE stream on GET and no session to
  // end on DELETE. The MCP Streamable HTTP transport expects 405 for both.
  app.all('/mcp', (_req: Request, res: Response) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Final error handler: without it Express answers with an HTML page that, when
  // NODE_ENV is unset, includes the stack trace. Never echo the exception.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = errorStatus(err);
    logger.warn('mcp request failed', { status, error_type: errorType(err) });
    res.status(status).json({ jsonrpc: '2.0', error: jsonRpcError(status), id: null });
  });

  return app;
}

function logCloseFailure(err: unknown): void {
  logger.debug('mcp server close failed', { error: err instanceof Error ? err.message : String(err) });
}

/** HTTP status carried by an Express/body-parser error, or 500. */
function errorStatus(err: unknown): number {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { status?: unknown; statusCode?: unknown };
  for (const candidate of [e.status, e.statusCode]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) return candidate;
  }
  return 500;
}

/** The error's `type` (body-parser) or class name — safe to log, unlike its message. */
function errorType(err: unknown): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { type?: unknown; name?: unknown };
  if (typeof e.type === 'string') return sanitizeForLog(e.type);
  return typeof e.name === 'string' ? sanitizeForLog(e.name) : 'unknown';
}

function jsonRpcError(status: number): { code: number; message: string } {
  if (status === 400) return { code: -32700, message: 'Parse error' };
  if (status === 413) return { code: -32600, message: 'Request body too large' };
  if (status < 500) return { code: -32600, message: 'Invalid request' };
  return { code: -32603, message: 'Internal error' };
}
