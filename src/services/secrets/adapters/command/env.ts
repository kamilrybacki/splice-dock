import type { CommandProviderConfig } from '../../../../config/types.js';
import { resolveAuthValue } from '../vault/resolver.js';

/**
 * Variables every minting command gets from splicedock's own environment:
 * enough to find executables, a home directory, a locale, a time zone and a
 * temp directory. Credentials and backend settings are never in this set.
 */
const BASE_ENV_NAMES = ['PATH', 'HOME', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR'] as const;
const LOCALE_PREFIX = 'LC_';

function isBaseName(name: string): boolean {
  return (BASE_ENV_NAMES as readonly string[]).includes(name) || name.startsWith(LOCALE_PREFIX);
}

/**
 * The environment handed to a mint command: the base set, then each
 * `env_allowlist` name that is set, then the `env` references resolved now.
 * Resolution is per mint and never cached; a reference that cannot be
 * resolved fails the mint rather than starting the command without it.
 */
export async function buildMintEnv(
  config: CommandProviderConfig,
  source: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string' && isBaseName(name)) env[name] = value;
  }
  for (const name of config.env_allowlist) {
    // Own keys only: names such as `toString` must not resolve through the prototype.
    const value = Object.hasOwn(source, name) ? source[name] : undefined;
    if (typeof value === 'string') env[name] = value;
  }
  for (const entry of config.env) {
    try {
      env[entry.name] = await resolveAuthValue(entry.from);
    } catch {
      throw new Error(`mint_env_unresolved: ${entry.name}`);
    }
  }
  return env;
}
