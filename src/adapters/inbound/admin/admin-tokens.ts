import { readFileSync } from 'node:fs';

/** Fixed identity recorded for the single legacy admin token. */
export const LEGACY_ADMIN_IDENTITY = 'admin';

export interface NamedAdminTokenConfig {
  name: string;
  token_env?: string;
  token_file?: string;
}

export interface NamedAdminToken {
  name: string;
  token: string;
}

function readToken(entry: NamedAdminTokenConfig): string {
  let raw: string | undefined;
  if (entry.token_env) {
    raw = process.env[entry.token_env];
    if (!raw?.trim()) {
      throw new Error(`Admin token '${entry.name}': env var '${entry.token_env}' is not set or empty`);
    }
  } else if (entry.token_file) {
    try {
      raw = readFileSync(entry.token_file, 'utf8');
    } catch (err) {
      throw new Error(`Admin token '${entry.name}': cannot read token file (${(err as NodeJS.ErrnoException).code ?? 'error'})`, { cause: err });
    }
    if (!raw.trim()) throw new Error(`Admin token '${entry.name}': token file is empty`);
  } else {
    throw new Error(`Admin token '${entry.name}': set token_env or token_file`);
  }
  return raw.trim();
}

/**
 * Resolve named admin tokens from env vars / files. Never includes a token
 * value in an error message. Rejects the reserved legacy name and two names
 * that resolve to the same token (identity would be ambiguous).
 */
export function resolveNamedAdminTokens(entries: readonly NamedAdminTokenConfig[]): NamedAdminToken[] {
  const out: NamedAdminToken[] = [];
  const seenTokens = new Map<string, string>();
  for (const entry of entries) {
    if (entry.name === LEGACY_ADMIN_IDENTITY) {
      throw new Error(`Admin token name '${LEGACY_ADMIN_IDENTITY}' is reserved for the legacy token`);
    }
    const token = readToken(entry);
    const other = seenTokens.get(token);
    if (other) throw new Error(`Admin tokens '${other}' and '${entry.name}' share the same token`);
    seenTokens.set(token, entry.name);
    out.push({ name: entry.name, token });
  }
  return out;
}
