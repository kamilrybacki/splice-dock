import yaml from 'js-yaml';
import type { RegistryEntry } from '../../../application/registry/tool-registry.js';
import type { ToolRegistry } from '../../../application/registry/tool-registry.js';
import type { ProfileRegistry } from '../../../application/registry/profile-registry.js';
import type { SplicedockConfig } from '../../../config/types.js';

const DUMP_OPTS: yaml.DumpOptions = { indent: 2, lineWidth: 120, noRefs: true };

/** Serialise complete profile manifests, never catalog metadata such as source
 * or revision. Credential values are references; no secret is resolved here. */
function profilesToObject(
  profiles: Array<{ name: string; tools: string[]; enable_code_mode?: boolean; credentials?: object }>,
): Record<string, { tools: string[]; enable_code_mode: boolean; credentials: object }> {
  const obj = Object.create(null) as Record<string, { tools: string[]; enable_code_mode: boolean; credentials: object }>;
  for (const profile of profiles) {
    obj[profile.name] = {
      tools: profile.tools,
      enable_code_mode: profile.enable_code_mode === true,
      credentials: profile.credentials ?? {},
    };
  }
  return obj;
}

export function exportToolsYaml(entries: RegistryEntry[]): string {
  const tools = entries.map(e => e.config);
  return yaml.dump({ tools }, DUMP_OPTS);
}

export function exportProfilesYaml(registry: ProfileRegistry): string {
  const profiles = profilesToObject(registry.getAllProfiles());
  return yaml.dump({ profiles }, DUMP_OPTS);
}

export function exportFullManifest(
  toolReg: ToolRegistry,
  profileReg: ProfileRegistry,
  serverConfig: SplicedockConfig['server'],
): string {
  const tools = toolReg.getAllTools().map(e => e.config);
  const profiles = profilesToObject(profileReg.getAllProfiles());
  // Omit credential-locating keys (admin token env/file refs, metrics scrape
  // token env) so the manifest export never reveals where secrets live.
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    admin_token_env: _adminEnv,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    admin_tokens: _adminTokens,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    metrics_token_env: _metricsEnv,
    ...safeServerConfig
  } = serverConfig;

  return yaml.dump(
    { server: safeServerConfig, profiles, tools },
    DUMP_OPTS,
  );
}
