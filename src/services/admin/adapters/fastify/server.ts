import type {ShadowObserver} from '../../../shadow/base.js';
import type {CircuitBreaker} from '../../../policy/circuit-breaker.js';
import { ConsentStore } from '../../../approvals/consent-store.js';
import { WebAuthnConsent } from '../../../approvals/adapters/fastify/webauthn.js';
import { registerConsentRoutes, registerEnrollmentRoutes, registerWeakConsentRoutes } from '../../../approvals/adapters/fastify/server.js';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import { buildAdminAuthHook, buildAdminTokenSet } from './auth.js';
import { resolveNamedAdminTokens } from './admin-tokens.js';
import { registerMcpUpstreamRoutes } from './routes/mcp-upstreams.js';
import type { McpUpstreamManager } from '../../../upstreams/base.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerProfileTokenRoutes } from './routes/profile-tokens.js';
import { registerManifestRoutes } from './routes/manifest.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerPushRoutes } from './routes/push.js';
import { registerWebUiRoutes } from './web.js';
import type { ToolRegistry } from '../../../tools/tool-registry.js';
import type { ProfileRegistry } from '../../../profiles/profile-registry.js';
import type { ToolDefinitions } from '../../../tools/base.js';
import type { ProfileAccess } from '../../../profiles/base.js';
import type { McpProxyDriver } from '../../../upstreams/adapters/mcp/driver.js';
import type { SplicedockConfig, CliPassthroughToolConfig } from '../../../../config/types.js';
import type { Metrics } from '../../../../common/metrics.js';
import type { AuditBuffer } from '../../../audit/base.js';
import type { ToolMetrics } from '../../../metrics/base.js';
import type { PolicyStore } from '../../../policy/base.js';
import type { ApprovalService } from '../../../approvals/base.js';
import type { SplicedockStore } from '../../../database/adapters/store.js';
import type { PushSubscriptionStore } from '../../../database/adapters/push-store.js';
import type { PushNotifier } from '../../../approvals/adapters/web-push/notifier.js';
import type { InvalidationPublisher } from '../../../../contracts/outbound/invalidation-bus.js';

export interface AdminExtras {
  auditBuffer: AuditBuffer;
  toolMetrics: ToolMetrics;
  policyStore: PolicyStore;
  approvalService?: ApprovalService;
  breaker?:CircuitBreaker;
  shadow?:ShadowObserver;
  // When present, runtime http/cli tools added via the API are persisted.
  store?: SplicedockStore;
  pushStore?: PushSubscriptionStore;
  pushNotifier?: PushNotifier;
  // Announces committed tool/profile writes to sibling replicas (Postgres only).
  invalidation?: InvalidationPublisher;
  // Runtime mcp_proxy upstream management (admin API + Add-tool wizard).
  mcpUpstreams?: McpUpstreamManager;
}

/** Constant-time bearer check (length guard first: timingSafeEqual throws on unequal lengths). */
function bearerMatches(header: string | undefined, expected: string): boolean {
  const m = typeof header === 'string' ? /^Bearer\s+(.+)$/.exec(header.trim()) : null;
  if (!m) return false;
  const got = Buffer.from(m[1].trim());
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function createAdminServer(
  toolRegistry: ToolRegistry,
  profileRegistry: ProfileRegistry,
  toolService: ToolDefinitions,
  profileService: ProfileAccess,
  proxyDrivers: Map<string, McpProxyDriver>,
  config: SplicedockConfig,
  metrics?: Metrics,
  extras?: AdminExtras,
) {
  const adminToken = process.env[config.server.admin_token_env];
  if (!adminToken) {
    throw new Error(`Admin token env var '${config.server.admin_token_env}' is not set`);
  }

  // Legacy token → identity "admin"; each named token → its own name (the approver identity).
  const adminTokens = buildAdminTokenSet(adminToken, resolveNamedAdminTokens(config.server.admin_tokens ?? []));

  const app = Fastify({ logger: false });
  app.decorateRequest('adminIdentity', undefined);
  app.register(sensible);
  // Needed for the /admin/login form (application/x-www-form-urlencoded).
  await app.register(formbody);

  // Rate limiting — applied to all routes.
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  const consent = extras?.store ? new WebAuthnConsent(new ConsentStore(extras.store.consentDatabase(),event=>metrics?.consent.inc({level:'strong',event})), config.server.consent,(event,latency,level='strong')=>{metrics?.consent.inc({level,event});if(latency!==undefined)metrics?.consentLatency.observe({level},latency);}) : undefined;
  if(consent) registerWeakConsentRoutes(app,consent);
  if(consent) metrics?.setPendingApprovalCollector(async ()=> (await consent.store.db.prepare("SELECT count(*) AS n FROM pending_approvals WHERE status='pending' AND expires_at>?").get(Date.now()) as {n:number}).n);
  if(consent) await app.register(async scope=>registerConsentRoutes(scope,consent,extras?.approvalService?(id,by)=>extras.approvalService!.reject(id,by):undefined));

  // Public routes (no auth required) — health check and metrics for k8s/Docker probes.
  app.get('/api/v1/health', async (_req, reply) => {
    reply.send({ data: { status: 'ok' } });
  });

  // Optional scrape token: when the env var named by server.metrics_token_env is
  // set, /metrics requires `Authorization: Bearer <token>`; unset keeps it open.
  const metricsToken = process.env[config.server.metrics_token_env ?? 'SPLICEDOCK_METRICS_TOKEN'] || undefined;

  // GET /metrics — Prometheus exposition format (unauthenticated, scraped by Prometheus).
  // Combines the legacy process/registry metrics with splicedock_cli_* counters
  // when the WebUI extras are wired.
  app.get('/metrics', async (req, reply) => {
    if (metricsToken && !bearerMatches(req.headers['authorization'], metricsToken)) {
      reply.status(401).header('WWW-Authenticate', 'Bearer').send('unauthorized');
      return;
    }
    if (extras?.toolMetrics) {
      const legacy = metrics ? await metrics.registry.metrics() : '';
      reply.header('Content-Type', metrics?.registry.contentType ?? 'text/plain; version=0.0.4');
      return legacy + extras.toolMetrics.prometheus();
    }
    if (!metrics) {
      reply.status(503).send('metrics not configured');
      return;
    }
    reply.header('Content-Type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  // Authenticated routes are registered in an encapsulated plugin that adds the
  // auth hook to its own scope only — keeping the health route above public.
  await app.register(async (authed) => {
    authed.addHook('preHandler', buildAdminAuthHook(adminTokens));
    if(extras?.shadow)authed.get('/api/v1/shadow/summary',async()=>await extras.shadow!.summary());
    if(extras?.breaker){
      authed.get('/api/v1/breaker',async()=>await extras.breaker!.list());
      authed.post<{Params:{scope:string;action:string}}>('/api/v1/breaker/:scope/:action',async(req,reply)=>{
        if(!['reset','trip'].includes(req.params.action))return reply.code(404).send();
        // Identity is established by the admin auth hook; reasons are fixed codes, never request text.
        const ok=await extras.breaker!.control(req.params.scope,req.params.action==='trip',req.adminIdentity ?? 'admin');
        return ok?{ok:true}:reply.code(404).send();
      });
    }
    if(consent) registerEnrollmentRoutes(authed,consent);
    registerStatusRoutes(authed, toolRegistry, proxyDrivers);
    registerToolRoutes(authed, toolRegistry, toolService, extras?.store, config.server.cli_whitelist, extras?.invalidation);
    if (extras?.mcpUpstreams) registerMcpUpstreamRoutes(authed, extras.mcpUpstreams, config.server.mcp_upstream_allowlist, extras.invalidation);
    registerProfileRoutes(authed, profileRegistry, profileService, extras?.store, extras?.invalidation);
    registerManifestRoutes(authed, toolRegistry, profileRegistry, config.server);
    if (extras?.store) registerProfileTokenRoutes(authed, extras.store, config.server.token_policy);

    if (extras) {
      registerPolicyRoutes(authed, config, extras.policyStore, () => profileRegistry.getAllProfiles().map(p => p.name));
      registerAuditRoutes(authed, extras.auditBuffer);
      registerUsageRoutes(authed, extras.toolMetrics);
      if (extras.approvalService) {
        registerApprovalRoutes(authed, extras.approvalService);
      }
      if (extras.pushStore) {
        registerPushRoutes(authed, extras.pushStore, extras.pushNotifier);
      }
    }
  });

  // WebUI — login route is unauthenticated (post sets the cookie); the
  // dashboard pages enforce session via cookie inside the route. Mounted at
  // the root level so /admin/login is reachable.
  if (extras) {
    registerWebUiRoutes(app, {
      expectedToken: adminToken,
      tokens: adminTokens,
      autheliaBypassSecret: process.env['SPLICEDOCK_AUTHELIA_SECRET'] || undefined,
      snapshot: async () => {
        const policies = await Promise.all((config.tools.filter(t => t.type === 'cli_passthrough') as CliPassthroughToolConfig[])
          .map(t => extras.policyStore.view(t)));
        const recent_denies = extras.auditBuffer.recent(50, { decision: 'deny' });
        const metricsList = extras.toolMetrics.list().map(m => ({
          tool: m.tool, total: m.total, allow: m.allow, deny: m.deny,
          // 24 hourly buckets covering the last 24h — feeds the dashboard
          // sparkline and the "calls 24h" KPI.
          buckets_24h: m.buckets_1h,
        }));
        return { policies, recent_denies, metrics: metricsList };
      },
      detail: async (tool, profileParam) => {
        const cfg = (config.tools.find(t => t.type === 'cli_passthrough' && t.name === tool) as CliPassthroughToolConfig | undefined);
        if (!cfg) return null;
        const view = await extras.policyStore.view(cfg);
        const profiles = profileRegistry.getAllProfiles().map(p => p.name).sort();
        const profile = profileParam && profiles.includes(profileParam) ? profileParam : null;
        const profile_override = profile ? await extras.policyStore.getProfileOverride(tool, profile) : null;
        const m = extras.toolMetrics.get(tool);
        const recent = extras.auditBuffer.recent(20, { tool });
        return {
          view, profiles, profile, profile_override,
          metric: m ? {
            total: m.total, allow: m.allow, deny: m.deny,
            rule_denies: m.rule_denies, buckets_1h: m.buckets_1h,
          } : null,
          recent,
        };
      },
      auditList: async (limit) => extras.auditBuffer.recent(limit),
      metricsList: async () => extras.toolMetrics.list().map(m => ({
        tool: m.tool, total: m.total, allow: m.allow, deny: m.deny,
        rule_denies: m.rule_denies, last_ts: m.last_ts,
      })),
      grantsEnabled: extras.approvalService?.grants.enabled,
      approvalsList: extras.approvalService
        ? async (status) => {
            const rows = (await extras.approvalService!.list({ status:status==='grant'?undefined:status, limit: 200 })).filter(r=>status!=='grant' || r.consent_method==='grant');
            return rows.map(r => ({
              id: r.id,
              tool: r.tool,
              argv: r.argv,
              rule: r.rule,
              matched: r.matched,
              status: r.status,
              requested_at: r.requested_at,
              expires_at: r.expires_at,
              cwd: r.cwd,
              approval_context: r.approval_context,
              consent_method: r.consent_method,
            }));
          }
        : undefined,
      approvalDetail: extras.approvalService
        ? async (id) => {
            const row = await extras.approvalService!.get(id);
            return row;
          }
        : undefined,
    });
  }

  return app;
}
