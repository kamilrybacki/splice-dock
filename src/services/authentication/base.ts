import { createHash, randomBytes } from 'node:crypto';

/** Generate a fresh opaque profile token (32 random bytes, base64url). It is
 *  shown to the caller exactly once at creation; only its hash is persisted. */
export function generateProfileToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 hex of a raw profile token — the single source of the hashing
 *  algorithm, shared by the mint route and the MCP-port bearer lookup. */
export function hashProfileToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
