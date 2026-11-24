import { loadConfig } from './config-file.js';
import { logger, setLogSink } from './common/logger.js';
import { stdoutLogSink } from './stdout-log-sink.js';
import { resolveDbTarget } from './services/database/adapters/target.js';
import { SplicedockStore } from './services/database/adapters/store.js';
import { credentialAdapters } from './services/secrets/adapters/index.js';
import { configureSecretGuard } from './services/secrets/adapters/vault/guard.js';
import { configureCredentialBroker } from './services/secrets/broker.js';
import { setLifecycleMetrics } from './services/authentication/lifecycle/events.js';
import { startTokenSweep } from './services/authentication/lifecycle/tokens.js';
import { createPrometheusMetrics } from './services/metrics/adapters/prometheus/index.js';
import { ToolRegistry } from './services/tools/registry.js';
import { ToolService } from './services/tools/base.js';
import { ToolRefreshService } from './services/tools/refresh.js';
import { loadRuntimeTools } from './services/tools/runtime/loader.js';
import { configurePassthrough, invalidatePolicyForTool } from './services/tools/adapters/cli/passthrough.js';
import { ProfileRegistry } from './services/profiles/registry.js';
import { ProfileService } from './services/profiles/base.js';
import { loadRuntimeProfiles, seedProfilesFromConfig } from './services/profiles/runtime/loader.js';
import { yamlManifestCodec } from './services/profiles/adapters/yaml.js';
import { McpProxyDriver } from './services/upstreams/adapters/mcp/driver.js';
import { PodResolver } from './services/upstreams/adapters/dns/pods.js';
import { McpUpstreamManager } from './services/upstreams/base.js';
import { AuditBuffer } from './services/audit/base.js';
import { ToolMetrics } from './services/metrics/base.js';
import { PolicyStore } from './services/policy/base.js';
import { createAdminServer } from './services/admin/adapters/fastify/server.js';
import { createConfigReloader } from './services/admin/config-reload.js';
import { setApprovalWaitHandler } from './services/mcp/adapters/express/server.js';
import { createApprovals } from './create-approvals.js';
import { createCacheSync } from './create-cache-sync.js';
import { createToolHooks } from './create-hooks.js';
import { createMcpServer } from './create-mcp.js';
import { createBreaker, createShadow } from './create-observers.js';
import { proxyConfigsOf, registerFileTools, resolveAvailablePassthroughs } from './create-tools.js';
import { drainTimeoutMs, registerShutdown } from './shutdown.js';

const CONFIG_PATH = process.env['SPLICEDOCK_CONFIG'] ?? '/etc/splicedock/splicedock.yaml';

setLogSink(stdoutLogSink);

async function main() {
  // ----- Config -----
  const config = loadConfig(CONFIG_PATH);
  if (config.server.consent.enabled && (!config.server.consent.rp_id || !config.server.consent.origin)) {
    throw new Error('strong consent requires configured rp_id and HTTPS origin; configure before startup or explicitly disable consent');
  }
  const env = process.env;

  // ----- Infrastructure: secrets, metrics, tool/profile registries -----
  configureSecretGuard(config.server.vault);
  configureCredentialBroker({ providers: config.credential_providers, storage: config.credential_storage }, credentialAdapters);
  const metrics = createPrometheusMetrics();
  setLifecycleMetrics(metrics);

  const availablePassthroughs = await resolveAvailablePassthroughs(config.tools);
  const toolRegistry = new ToolRegistry();
  const profileRegistry = new ProfileRegistry();
  const toolService = new ToolService(toolRegistry);
  const profileService = new ProfileService(profileRegistry, toolRegistry);

  // Per-profile credentials, in order: the profile's own entry, then
  // credential_defaults (how a profile created at runtime gets credentialed),
  // then the tool-level credential. Unknown profiles resolve to undefined.
  const credentialFor = (profileName: string, tool: string) =>
    profileRegistry.getProfile(profileName)?.credentials?.[tool] ?? config.credential_defaults[tool];

  // ----- Upstream discovery -----
  const proxyConfigs = proxyConfigsOf(config.tools);
  const podResolver = new PodResolver();
  // Always built (even with zero YAML upstreams) so runtime upstreams added via the
  // admin API/wizard are discovered and refreshed. proxyConfigs is shared with the
  // MCP server and mutated by McpUpstreamManager.
  const refreshService = new ToolRefreshService(
    proxyConfigs, toolRegistry, podResolver, metrics, logger,
    proxyConfigs.length > 0 ? Math.min(...proxyConfigs.map(c => c.refresh_interval_ms)) : 600_000,
    cfg => new McpProxyDriver(cfg),
  );
  await refreshService.probeOnce();
  refreshService.start();
  registerFileTools(config.tools, toolService, toolRegistry, availablePassthroughs);

  // ----- Persistence (policy overrides, metrics, runtime tools/profiles, approvals, tokens) -----
  const dbTarget = resolveDbTarget(env);
  const store = await SplicedockStore.open(dbTarget);
  const upstreams = new McpUpstreamManager(proxyConfigs, toolRegistry, refreshService, store, logger);
  await seedProfilesFromConfig(store, config.profiles, logger, yamlManifestCodec);
  const stopTokenSweep = startTokenSweep(store, config.server.token_policy, metrics);
  const mcpServer = createMcpServer({
    config, profileService, toolRegistry, proxyConfigs, podResolver, metrics, store,
    authFor: (profileName, backend) => credentialFor(profileName, backend)?.auth,
  });

  const { invalidationBus, cacheSync } = await createCacheSync({ store, dbTarget, config, toolRegistry, toolService, profileRegistry, upstreams });
  // Re-register UI/API-added tools and profiles persisted from previous runs.
  await loadRuntimeTools(store, toolRegistry, toolService, logger, config.server.cli_whitelist);
  await upstreams.syncFromStore();
  await loadRuntimeProfiles(store, profileRegistry, logger, yamlManifestCodec);

  // ----- Services: audit, policy, shadow, breaker, approvals -----
  const auditBuffer = new AuditBuffer(2000); // in-memory only; Loki has the long-term log
  const toolMetrics = new ToolMetrics(store);
  await toolMetrics.start();
  const policyStore = new PolicyStore(store);
  policyStore.onChange(invalidatePolicyForTool);
  // Tell sibling replicas to drop their compiled-policy cache after the override committed.
  policyStore.onChange((tool) => { void invalidationBus.publish('policy', tool); });
  if (store.isPostgres) cacheSync.startReconcile();

  const shadow = await createShadow(store, config, metrics, env);
  const breaker = await createBreaker(store, config, metrics);
  const { approvalService, pushStore, pushNotifier } = createApprovals(store, config, metrics, env);
  setApprovalWaitHandler(async (id, timeout, caller, signal) => await approvalService.wait(id, timeout, caller, signal));
  configurePassthrough(createToolHooks({
    policyStore, auditBuffer, toolMetrics, metrics, shadow, breaker, approvalService,
    profileEnvFor: (tool, profileName) => credentialFor(profileName, tool)?.env,
  }));
  // Validate the complete config before reloading breaker/shadow and consent strength.
  const configReloader = createConfigReloader(() => loadConfig(CONFIG_PATH), { breaker, shadow, approvals: approvalService }, logger);
  process.on('SIGHUP', () => { void configReloader.reload(); });

  // ----- Entry adapters: admin API, then MCP -----
  // proxyDrivers map is empty (no shared connections); the status route lists
  // zero upstreams but tool counts still reflect the refresh-populated registry.
  const adminServer = await createAdminServer(
    toolRegistry, profileRegistry, toolService, profileService, new Map(), config, metrics,
    { auditBuffer, toolMetrics, policyStore, approvalService, store, mcpUpstreams: upstreams, breaker, shadow, pushStore, pushNotifier, invalidation: invalidationBus },
  );
  await adminServer.listen({ port: config.server.admin_port, host: '0.0.0.0' });
  logger.info('Admin API listening', { port: config.server.admin_port });

  registerShutdown({
    mcpServer,
    drainTimeoutMs: drainTimeoutMs(env),
    stops: [() => adminServer.close(), () => cacheSync.stop(), () => invalidationBus.stop(), () => toolMetrics.stop(), () => approvalService.stop(), stopTokenSweep, () => store.close()],
  });
  // Accept MCP calls only after the catalog and the policy and approval hooks are ready.
  mcpServer.listen(config.server.port, () => {
    logger.info('MCP server listening', { port: config.server.port });
  });
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
