import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { builtinCliProfiles } from './builtin-backends.js';
import { validateConfig } from './config/loader.js';
import type { SplicedockConfig } from './config/types.js';
import type { CliProfileRegistry } from './services/policy/cli/profiles/index.js';

/** Parse YAML text (JSON schema: plain JSON types only) and validate it against the process environment. */
export function parseConfig(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
  cliProfiles: CliProfileRegistry = builtinCliProfiles,
): SplicedockConfig {
  return validateConfig(yaml.load(raw, { schema: yaml.JSON_SCHEMA }), env, cliProfiles);
}

export function loadConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  cliProfiles: CliProfileRegistry = builtinCliProfiles,
): SplicedockConfig {
  try {
    return parseConfig(readFileSync(path, 'utf8'), env, cliProfiles);
  } catch (err) {
    throw new Error(`Failed to load config from ${path}: ${(err as Error).message}`, { cause: err });
  }
}
