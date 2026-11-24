const MAX_CLIENT_FIELD_LENGTH = 64;
// C0/C1 controls plus invisible line/format chars (line separators, zero-width, bidi overrides).
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g; // eslint-disable-line no-control-regex

/** Self-reported, untrusted text: strings only, control chars stripped, capped. */
export function sanitizeClientField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(CONTROL_CHARS, '').slice(0, MAX_CLIENT_FIELD_LENGTH);
  return clean.length > 0 ? clean : undefined;
}

/**
 * Log fields for the calling MCP client. Prefers `clientInfo` from `initialize`;
 * the stateless HTTP transport usually loses it on `tools/call`, so the
 * sanitised `User-Agent` header is the fallback for `client`. Self-reported:
 * informational only, never an authorization input or a metric label.
 */
export function clientLogFields(
  info: { name?: unknown; version?: unknown } | undefined,
  userAgent?: unknown,
): { client?: string; client_version?: string } {
  const client = sanitizeClientField(info?.name) ?? sanitizeClientField(userAgent);
  const clientVersion = sanitizeClientField(info?.version);
  return {
    ...(client !== undefined && { client }),
    ...(clientVersion !== undefined && { client_version: clientVersion }),
  };
}
