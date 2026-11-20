/**
 * Set both names before startup modules read their environment. Existing service
 * units can supply CELLARETTE_* while new configurations use SPLICEDOCK_*.
 * Prefer the canonical spelling when both names are supplied.
 */
export function applyEnvironmentAliases(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (!/^(?:SPLICEDOCK|CELLARETTE)_/.test(name)) continue;
    const suffix = name.replace(/^(?:SPLICEDOCK|CELLARETTE)_/, '');
    const canonical = 'SPLICEDOCK_' + suffix;
    const legacy = 'CELLARETTE_' + suffix;
    const value = env[canonical] ?? env[legacy];
    if (value === undefined) continue;
    env[canonical] = value;
    env[legacy] = value;
  }
}

applyEnvironmentAliases(process.env);
