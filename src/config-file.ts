import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { validateConfig } from './config/loader.js';
import type { SplicedockConfig } from './config/types.js';

/** Parse YAML text (JSON schema: plain JSON types only) and validate it against the process environment. */
export function parseConfig(raw: string, env: NodeJS.ProcessEnv = process.env): SplicedockConfig {
  return validateConfig(yaml.load(raw, { schema: yaml.JSON_SCHEMA }), env);
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): SplicedockConfig {
  try {
    return parseConfig(readFileSync(path, 'utf8'), env);
  } catch (err) {
    throw new Error(`Failed to load config from ${path}: ${(err as Error).message}`, { cause: err });
  }
}
