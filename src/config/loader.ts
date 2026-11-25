import { splicedockConfigSchema, type SplicedockConfig } from './schema.js';
import { compilePolicy, PolicyCompileError } from '../services/policy/cli/rules.js';
import type { CliProfileRegistry } from '../services/policy/cli/profiles/index.js';
import { KUBECONFIG_RELATIVE_MESSAGE, KUBECONFIG_VAR, kubeconfigIsRelative } from '../services/policy/cli/kubeconfig/path.js';

/** Environment lookup the config rules consult (process.env is passed in by the caller). */
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

/** Every KUBECONFIG value a tool would pass that can be read without a live
 *  call: bare names and env: refs. vault: refs are checked at call time. All
 *  matching refs are returned, so a duplicate declaration cannot hide one. */
function declaredKubeconfigs(
  tool: Extract<SplicedockConfig['tools'][number], { type: 'cli_passthrough' }>,
  env: ConfigEnv,
): readonly (string | undefined)[] {
  return tool.env.flatMap(ref => {
    if (typeof ref === 'string') return ref === KUBECONFIG_VAR ? [env[KUBECONFIG_VAR]] : [];
    if (ref.name !== KUBECONFIG_VAR || !('from' in ref) || !ref.from.startsWith('env:')) return [];
    return [env[ref.from.slice('env:'.length)]];
  });
}

/** Fold the legacy top-level `deny_subcommands` on cli_passthrough tools into
 *  `policy.deny_subcommands` and pre-compile policies so bad regex / mutually-
 *  exclusive rules fail at config-load time rather than on first __run. */
function normalizeCliPassthroughPolicy(
  config: SplicedockConfig,
  env: ConfigEnv,
  cliProfiles: CliProfileRegistry,
): SplicedockConfig {
  for (const tool of config.tools) {
    if (tool.type !== 'cli_passthrough') continue;
    if (declaredKubeconfigs(tool, env).some(kubeconfigIsRelative)) {
      throw new Error(`cli_passthrough '${tool.name}': ${KUBECONFIG_RELATIVE_MESSAGE}`);
    }
    const legacy = tool.deny_subcommands ?? [];
    const policyDeny = tool.policy?.deny_subcommands ?? [];
    if (legacy.length > 0 && policyDeny.length > 0) {
      throw new Error(
        `cli_passthrough '${tool.name}': set deny_subcommands at the top level OR inside policy, not both`,
      );
    }
    if (legacy.length > 0) {
      tool.policy = {
        max_args: 256,
        on_violation: 'deny' as const,
        audit: false,
        ...(tool.policy ?? {}),
        deny_subcommands: legacy,
      };
      // Top-level field intentionally retained for round-trip serialization.
      // The runtime always reads from tool.policy after this normalization.
    }
    // Eager compile so misconfigurations crash startup instead of leaking
    // through to a first-use 500. Schema comment promises this; we honor it.
    if (tool.policy) {
      try {
        compilePolicy(tool.policy, { profile: cliProfiles.profileFor(tool.command), knownSubcommands: tool.known_subcommands });
      } catch (err) {
        if (err instanceof PolicyCompileError) {
          throw new Error(`cli_passthrough '${tool.name}': ${err.message}`, { cause: err });
        }
        throw err;
      }
    }
  }
  return config;
}

/** Every minting credential source inside an HTTP auth object, with its field name. */
function authSources(auth: unknown): Array<{ field: string; mint: string }> {
  if (!auth || typeof auth !== 'object') return [];
  const record = auth as Record<string, unknown>;
  if (record['type'] === 'bearer') return mintSource('token', record['token']);
  if (record['type'] === 'header') return mintSource('value', record['value']);
  return [];
}

function mintSource(field: string, source: unknown): Array<{ field: string; mint: string }> {
  if (source && typeof source === 'object' && typeof (source as { mint?: unknown }).mint === 'string') {
    return [{ field, mint: (source as { mint: string }).mint }];
  }
  return [];
}

/**
 * Reject credential bindings that cannot be honoured. A typo in the tool or
 * provider name would otherwise fail open: the profile keeps the shared
 * tool-level credential, or a mint silently never happens.
 *
 * `mint:` needs a caller identity, so it is refused everywhere credentials are
 * resolved without one: tool-level `auth`, tool-level `env` (resolved at
 * startup) and startup tool discovery.
 */
function validateCredentialBindings(config: SplicedockConfig): SplicedockConfig {
  const tools = new Map(config.tools.map(t => [t.name, t]));
  const providers = new Set(Object.keys(config.credential_providers));
  const requireProvider = (where: string, name: string): void => {
    if (!providers.has(name)) {
      throw new Error(`${where}: no credential_providers entry named '${name}'`);
    }
  };

  for (const tool of config.tools) {
    if (tool.type === 'mcp_proxy' || tool.type === 'http') {
      for (const { field, mint } of authSources(tool.auth)) {
        throw new Error(`tools.${tool.name}.auth.${field}: mint '${mint}' is only valid in profiles.<name>.credentials (tool-level auth is resolved without a profile identity)`);
      }
    }
    if (tool.type === 'cli_passthrough') {
      for (const ref of tool.env) {
        if (typeof ref !== 'string' && 'mint' in ref) {
          throw new Error(`tools.${tool.name}.env: 'mint' is only valid in profiles.<name>.credentials (tool-level env is resolved at startup, without a profile identity)`);
        }
      }
    }
  }

  const validateMap = (prefix: string, credentials: SplicedockConfig['profiles'][string]['credentials']): void => {
    for (const [toolName, credential] of Object.entries(credentials)) {
      const where = `${prefix}.${toolName}`;
      const tool = tools.get(toolName);
      if (!tool) {
        throw new Error(`${where}: no tool named '${toolName}'`);
      }
      if (credential.auth !== undefined && tool.type !== 'mcp_proxy' && tool.type !== 'http') {
        throw new Error(`${where}: 'auth' is only valid for mcp_proxy and http tools (this one is ${tool.type})`);
      }
      if (credential.env !== undefined && tool.type !== 'cli_passthrough') {
        throw new Error(`${where}: 'env' is only valid for cli_passthrough tools (this one is ${tool.type})`);
      }
      for (const { field, mint } of credential.auth ? authSources(credential.auth) : []) {
        requireProvider(`${where}.auth.${field}`, mint);
      }
      for (const ref of credential.env ?? []) {
        if (typeof ref !== 'string' && 'mint' in ref) requireProvider(`${where}.env`, ref.mint);
      }
    }
  };

  validateMap('credential_defaults', config.credential_defaults);
  for (const [profileName, profile] of Object.entries(config.profiles)) {
    validateMap(`profiles.${profileName}.credentials`, profile.credentials);
  }
  return config;
}

/** Validate an already-parsed config document. Parsing (YAML) and reading the
 *  file live in the composition root; `env` is the process environment. */
/** Validate a parsed config. `cliProfiles` must be the registry the runtime
 *  uses, so load-time compilation matches what calls are checked against. */
export function validateConfig(parsed: unknown, env: ConfigEnv, cliProfiles: CliProfileRegistry): SplicedockConfig {
  if (parsed === null || parsed === undefined) {
    throw new Error('Config is empty or contains only comments');
  }
  const config = splicedockConfigSchema.parse(parsed);
  return validateCredentialBindings(normalizeCliPassthroughPolicy(config, env, cliProfiles));
}
