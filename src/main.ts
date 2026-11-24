import { resolveDbTarget } from './services/database/base.js';
import { readGrantConfig } from './services/policy/grant-config.js';
import { setApprovalWaitHandler } from './services/mcp/adapters/express/server.js';
import {ShadowObserver} from './services/shadow/base.js';
import { credentialAdapters } from './services/secrets/adapters/index.js';
import { McpProxyDriver } from './services/upstreams/adapters/mcp/driver.js';
import {setObservationSink} from './services/tools/adapters/cli/passthrough.js';
import {CircuitBreaker} from './services/policy/circuit-breaker.js';
import {setCircuitBreaker} from './services/tools/adapters/cli/passthrough.js';
import { startTokenSweep } from './services/authentication/token-lifecycle.js';
import { setLifecycleMetrics } from './services/authentication/lifecycle-events.js';
import { configureSecretGuard } from './services/secrets/adapters/vault/guard.js';
import { configureCredentialBroker } from './services/secrets/broker.js';
import { createServer } from 'node:http';
import { loadConfig } from './config/loader.js';
import { ToolRegistry } from './services/tools/tool-registry.js';
import { ProfileRegistry } from './services/profiles/profile-registry.js';
import { ToolService } from './services/tools/base.js';
import { ProfileService } from './services/profiles/base.js';
import { createMcpExpressApp } from './services/mcp/adapters/express/server.js';
import { createAdminServer } from './services/admin/adapters/fastify/server.js';
import { SplicedockStore } from './services/database/adapters/store.js';
import { AuditBuffer } from './services/audit/base.js';
import { ToolMetrics } from './services/metrics/base.js';
import { PolicyStore } from './services/policy/base.js';
import {
  setEffectivePolicyResolver,
  setAuditSink,
  setMetricsSink,
  setApprovalHookFactory,
  setApprovalSettler,
  setPolicyDecisionSink,
  setProfileEnvResolver,
  invalidatePolicyForTool,
} from './services/tools/adapters/cli/passthrough.js';
import { ApprovalService } from './services/approvals/base.js';
import { PushSubscriptionStore } from './services/database/adapters/push-store.js';
import { createPushNotifier, vapidFromEnv } from './services/approvals/adapters/web-push/notifier.js';
import { installCliPassthroughTools } from './services/tools/adapters/cli/installer.js';
import { resolveAndInjectCliPassthroughEnv } from './services/secrets/adapters/env/cli-env.js';
import { logger } from './common/logger.js';
import { PodResolver } from './services/upstreams/adapters/dns/pod-resolver.js';
import { McpUpstreamManager } from './services/upstreams/base.js';
import { ToolRefreshService } from './services/tools/tool-refresh-service.js';
import { loadRuntimeTools, resyncRuntimeTools } from './services/tools/runtime-tool-loader.js';
import { loadRuntimeProfiles, resyncRuntimeProfiles, seedProfilesFromConfig } from './services/profiles/runtime-profile-loader.js';
import { createInvalidationBus } from './services/database/adapters/invalidation-bus.js';
import { CacheSync } from './services/runtime/base.js';
import { hashProfileToken } from './services/authentication/base.js';
import { createMetrics } from './common/metrics.js';
import { drainHttpServer } from './common/http-drain.js';

const CONFIG_PATH = process.env['SPLICEDOCK_CONFIG'] ?? '/etc/splicedock/splicedock.yaml';

// How long SIGTERM waits for in-flight MCP requests before force-closing them.
// Keep it below the pod's terminationGracePeriodSeconds minus the preStop sleep.
const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

function drainTimeoutMs(): number {
  const raw = Number(process.env['SPLICEDOCK_DRAIN_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DRAIN_TIMEOUT_MS;
}

async function main() {
  const config = loadConfig(CONFIG_PATH);
  if(config.server.consent.enabled && (!config.server.consent.rp_id || !config.server.consent.origin)) {
    throw new Error('strong consent requires configured rp_id and HTTPS origin; configure before startup or explicitly disable consent');
  }
  configureSecretGuard(config.server.vault);
  configureCredentialBroker({
    providers: config.credential_providers,
    storage: config.credential_storage,
  }, credentialAdapters);
  // Per-profile credentials: without them every profile shares the tool-level
  // credential (one upstream connection / one CLI identity). Unknown profiles
  // resolve to undefined and are refused by the profile-service anyway.
  // Resolution order: the profile's own entry, then credential_defaults (which
  // is how a profile created at runtime gets credentialed), then the tool-level
  // credential.
  const credentialFor = (profileName: string, tool: string) =>
    profileRegistry.getProfile(profileName)?.credentials?.[tool] ?? config.credential_defaults[tool];
  setProfileEnvResolver((tool, profileName) => credentialFor(profileName, tool)?.env);
  const metrics = createMetrics();
  setLifecycleMetrics(metrics);

  const passthroughConfigs = config.tools.filter(t => t.type === 'cli_passthrough');
  const availablePassthroughs = new Set<string>();
  if (passthroughConfigs.length > 0) {
    // 1. Resolve vault-referenced env vars BEFORE installing — some install scripts may need
    //    authenticated downloads (e.g. GH_TOKEN for rate-limited github release pulls).
    const envStats = await resolveAndInjectCliPassthroughEnv(passthroughConfigs);
    logger.info('cli_passthrough env resolution summary', envStats);

    // 2. Probe + install + verify each declared tool. Only tools that end up `available` are
    //    registered below — Claude never sees broken tools.
    const installResults = await installCliPassthroughTools(passthroughConfigs);
    for (const result of installResults) {
      if (result.status === 'available') availablePassthroughs.add(result.name);
    }
    logger.info('cli_passthrough availability summary', {
      total: installResults.length,
      available: installResults.filter(r => r.status === 'available').length,
      failed: installResults.filter(r => r.status === 'failed').length,
      available_tools: [...availablePassthroughs].sort(),
    });
  }

  const toolRegistry = new ToolRegistry();
  const profileRegistry = new ProfileRegistry();

  const toolService = new ToolService(toolRegistry);

  // Resolve proxy upstreams — drivers are now allocated per-session at SSE connect time.
  const proxyConfigs = config.tools.filter(t => t.type === 'mcp_proxy') as import('./config/types.js').McpProxyToolConfig[];

  const podResolver = new PodResolver();
  // Always built (even with zero YAML upstreams) so runtime upstreams added via the
  // admin API/wizard are discovered and refreshed. proxyConfigs is shared with the
  // MCP server and mutated by McpUpstreamManager.
  const refreshService = new ToolRefreshService(
    proxyConfigs,
    toolRegistry,
    podResolver,
    metrics,
    logger,
    proxyConfigs.length > 0 ? Math.min(...proxyConfigs.map(c => c.refresh_interval_ms)) : 600_000,
    cfg => new McpProxyDriver(cfg),
  );
  await refreshService.probeOnce();
  refreshService.start();

  // Load non-proxy tools
  for (const toolConfig of config.tools) {
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

  const profileService = new ProfileService(profileRegistry, toolRegistry);

  // Persistent store (SQLite): policy overrides, metrics snapshots, runtime
  // tools/profiles, approvals, and profile tokens. Opened before the MCP app so
  // the MCP port can resolve bearer profile tokens against it.
  const dbTarget = resolveDbTarget(process.env);
  const store = await SplicedockStore.open(dbTarget);
  const mcpUpstreamManager = new McpUpstreamManager(proxyConfigs, toolRegistry, refreshService, store, logger);
  await seedProfilesFromConfig(store, config.profiles, logger);

  const stopTokenSweep = startTokenSweep(store, config.server.token_policy, metrics);
  // Start MCP SSE server — per-session driver allocation via proxyConfigs + resolver.
  const mcpApp = createMcpExpressApp(
    profileService,
    toolRegistry,
    new Map(), // shared map is empty; drivers are allocated per-session
    config.server.cli_whitelist,
    {
      proxyConfigs,
      resolver: podResolver,
      metrics,
      requireProfileToken: config.server.require_profile_token,
      // A `Authorization: Bearer <profile-token>` binds the session to that
      // token's profile; `?profile=` is then ignored. Unknown bearer → 401.
      lookupProfileByToken: rawToken => store.findProfileByToken(hashProfileToken(rawToken), Date.now()),
      profileAuth: (profileName, backend) => credentialFor(profileName, backend)?.auth,
    },
  );
  const mcpServer = createServer(mcpApp);

  // ----- Audit ring, tool metrics, policy overrides -----
  // Audit ring is in-memory only; Loki has the long-term log via stdout JSON.
  // The persistent `store` was opened above (the MCP port needs it for tokens).

  // Cross-replica cache invalidation (no-op on SQLite). Order matters: record
  // the DB digests and start listening BEFORE the initial load, so a change
  // committed by a sibling during startup is picked up by the first reconcile
  // or a bus message instead of falling in the gap.
  const invalidationBus = createInvalidationBus({
    dbTarget,
    isPostgres: store.isPostgres,
    publishVia: (channel, payload) => store.notify(channel, payload),
  });
  const cacheSync = new CacheSync({
    reloadTools: async () => {
      await resyncRuntimeTools(store, toolRegistry, toolService, logger, config.server.cli_whitelist);
      await mcpUpstreamManager.syncFromStore();
    },
    reloadProfiles: () => resyncRuntimeProfiles(store, profileRegistry, logger),
    invalidatePolicy: (tool) => invalidatePolicyForTool(tool ?? '*'),
    fingerprint: () => store.runtimeFingerprint(),
    log: logger,
  });
  if (store.isPostgres) {
    await cacheSync.prime();
    cacheSync.attach(invalidationBus);
    await invalidationBus.start();
  }

  // Re-register UI/API-added http/cli tools persisted from previous runs.
  await loadRuntimeTools(store, toolRegistry, toolService, logger, config.server.cli_whitelist);
  await mcpUpstreamManager.syncFromStore();

  await loadRuntimeProfiles(store, profileRegistry, logger);

  const auditBuffer = new AuditBuffer(2000);
  const toolMetrics = new ToolMetrics(store);
  await toolMetrics.start();
  const policyStore = new PolicyStore(store);

  // Wire the cli_passthrough wrapper to consult the override store on every
  // call, record audit events, and bump usage counters. Invalidate the cached
  // compiled policy whenever an override changes.
  setEffectivePolicyResolver((cfg, profile) => policyStore.effective(cfg, profile));
  policyStore.onChange(invalidatePolicyForTool);
  // Tell sibling replicas to drop their compiled-policy cache after the override committed.
  policyStore.onChange((tool) => { void invalidationBus.publish('policy', tool); });
  if (store.isPostgres) cacheSync.startReconcile();
  setAuditSink(entry => auditBuffer.push({ ...entry, ts: Date.now() }));
  setMetricsSink(metricsEntry => toolMetrics.record(metricsEntry));

  // ----- Approval flow (on_violation: approval) -----
  // Wires the SQLite-backed ApprovalService. Approval rows survive restarts;
  // operators find pending rows in the admin WebUI (/admin/approvals).
  const approvalTtlMs = (() => {
    const raw = process.env['APPROVAL_TTL_SEC'];
    if (!raw) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
  })();
  const shadow=await ShadowObserver.create(store.consentDatabase(),config.server.shadow,undefined,(outcome,latency,depth,agreement)=>{metrics.shadowTotal.inc({outcome});metrics.shadowLatency.observe(latency/1000);metrics.shadowDepth.set(depth);if(agreement)metrics.shadowAgreement.inc({result:agreement});});
  metrics.setShadowPSICollector(()=>shadow.psi());
  setObservationSink((e,argv,cwd)=>shadow.submit({tool:e.tool,profile:e.profile,argv,cwd},e.decision));
  const breaker=await CircuitBreaker.create(store.consentDatabase(),config.server.breaker,(event,family,state)=>{metrics.breakerEvents.inc({event,scope:family});if(event==='would_trip')metrics.breakerWouldTrip.inc({scope:family});if(event==='forced'){metrics.breakerForced.inc({scope:family});metrics.breakerEscalations.inc();}if(state)metrics.breakerTransitions.inc({scope:family,to:state});if(state)metrics.breakerState.set({scope:family},state==='open'?2:state==='half_open'?1:0);});
  setCircuitBreaker(breaker);
  // Validate the complete config before reloading breaker/shadow and consent strength.
  process.on('SIGHUP',()=>{void (async ()=>{
    try{
      const next=loadConfig(CONFIG_PATH);
      await store.consentDatabase().prepare('INSERT INTO breaker_audit(ts,scope,event,actor) VALUES(?,?,?,?)').run(Date.now(),'configured',`config_${next.server.breaker.enabled?next.server.breaker.mode:'disabled'}`,'operator_signal');
      Object.assign(breaker.config,next.server.breaker);
      Object.assign(shadow.config,next.server.shadow);
      approvalService.reconfigureStrongTools(next.server.consent.strong_default_tools);
      logger.info('breaker/shadow configuration reloaded');
    }catch(err){logger.warn('breaker/shadow reload refused',{error:err instanceof Error?err.message:String(err)});}
  })();});
  const pushStore = new PushSubscriptionStore(store.consentDatabase());
  const vapid = vapidFromEnv(process.env);
  const pushNotifier = vapid ? createPushNotifier({ store: pushStore, vapid }) : undefined;
  logger.info(pushNotifier ? 'web push enabled' : 'web push disabled (no VAPID keys)');
  const grantConfig = readGrantConfig(process.env);
  const approvalService = new ApprovalService({
    store,
    grantsEnabled: process.env.SPLICEDOCK_GRANTS === '1',
    grantThreshold: grantConfig.threshold,
    grantContextMinSim: grantConfig.minSimilarity,
    grantExceptions: grantConfig.exceptions,
    onGrantUsed: (tool,verb) => metrics.approvalGrantUsed.inc({tool,verb}),
    ttlMs: approvalTtlMs ?? config.server.consent.approval_ttl_seconds * 1000,
    strongTools: config.server.consent.strong_default_tools,
    consentEnabled:config.server.consent.enabled,
    linkTtlMs:config.server.consent.link_ttl_seconds * 1000,
    consentOrigin:config.server.consent.enabled ? config.server.consent.origin : undefined,
    onConsentEvent:(level,event,latency)=>{metrics.consent.inc({level,event});if(latency!==undefined)metrics.consentLatency.observe({level},latency);},
    onEvent: (tool, event) => metrics.approvals.inc({ tool, event }),
    onRequested: pushNotifier ? (info) => { void pushNotifier.notify(info); } : undefined,
  });
  setApprovalWaitHandler(async (id, timeout, caller, signal) => await approvalService.wait(id, timeout, caller, signal));
  setPolicyDecisionSink(e => metrics.policyDecisions.inc(e as unknown as Record<string, string>));
  setApprovalHookFactory((tool, { cwd,requireStrong,approvalContext }) => approvalService.makeHook(tool, cwd,undefined,requireStrong,approvalContext));
  setApprovalSettler(approvalService);

  // Start Admin API server — proxyDrivers map is empty (no shared connections); status
  // route will list zero upstreams but tool counts still reflect the refresh-populated registry.
  const adminServer = await createAdminServer(
    toolRegistry,
    profileRegistry,
    toolService,
    profileService,
    new Map(),
    config,
    metrics,
    { auditBuffer, toolMetrics, policyStore, approvalService, store, mcpUpstreams: mcpUpstreamManager, breaker, shadow, pushStore, pushNotifier, invalidation: invalidationBus },
  );
  await adminServer.listen({ port: config.server.admin_port, host: '0.0.0.0' });
  logger.info('Admin API listening', { port: config.server.admin_port });

  // Accept MCP calls only after the catalog and the policy and approval hooks are ready.
  mcpServer.listen(config.server.port, () => {
    logger.info('MCP server listening', { port: config.server.port });
  });

  // Graceful shutdown. Order matters with several replicas behind one Service:
  // first stop taking MCP traffic and let in-flight calls finish (they still
  // need the store), then the admin API, then background work, and the store last.
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      (async () => {
        logger.info('shutting down', { signal });
        const drain = await drainHttpServer(mcpServer, drainTimeoutMs());
        logger.info('mcp server drained', { result: drain });
        await adminServer.close();
        cacheSync.stop();
        await invalidationBus.stop();
        await toolMetrics.stop();
        approvalService.stop();
        stopTokenSweep();
        await store.close();
      })().catch((err) => {
        logger.error('shutdown error', { error: err instanceof Error ? err.message : String(err) });
      }).finally(() => process.exit(0));
    });
  }
}

if (process.argv[2] === 'db') {
  void import('./services/database/adapters/cli/migrate.js').then(m => m.runDbCli(process.argv.slice(3), process.env)).then(code => process.exit(code));
} else main().catch(err => {
  logger.error('startup failed', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
