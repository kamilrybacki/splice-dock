/** The only place that interprets these process environment variables for the services. */
export type Env = Readonly<Record<string, string | undefined>>;

/** APPROVAL_TTL_SEC: positive integer seconds, returned as ms; anything else means "use config". */
export function approvalTtlMsFromEnv(env: Env): number | undefined {
  const raw = env['APPROVAL_TTL_SEC'];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n * 1000 : undefined;
}

/** SPLICEDOCK_GRANTS=1 enables approval grants. */
export function grantsEnabledFromEnv(env: Env): boolean {
  return env['SPLICEDOCK_GRANTS'] === '1';
}

/** SPLICEDOCK_SHADOW=off disables the shadow observer regardless of config. Read live. */
export function shadowKillSwitchFromEnv(env: Env): boolean {
  return env['SPLICEDOCK_SHADOW'] === 'off';
}
