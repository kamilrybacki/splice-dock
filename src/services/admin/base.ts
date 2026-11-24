import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const LEGACY_ADMIN_IDENTITY = 'admin';

export interface NamedAdminToken { name: string; token: string }

// Generate once at module load time — used to hash tokens to a fixed-length digest,
// preventing length side-channels without leaking the expected token length.
const HMAC_KEY = randomBytes(32);

function hmac(value: string): Buffer {
  return createHmac('sha256', HMAC_KEY).update(value).digest();
}

export interface AdminTokenSet {
  /** Identity for a presented token, or null. Compares against every entry (no early exit). */
  identify(token: string): string | null;
}

export function buildAdminTokenSet(legacyToken: string, named: readonly NamedAdminToken[] = []): AdminTokenSet {
  const entries = [
    { name: LEGACY_ADMIN_IDENTITY, digest: hmac(legacyToken) },
    ...named.map(n => ({ name: n.name, digest: hmac(n.token) })),
  ];
  return {
    identify(token: string): string | null {
      const presented = hmac(token);
      let match: string | null = null;
      for (const e of entries) {
        if (timingSafeEqual(presented, e.digest) && match === null) match = e.name;
      }
      return match;
    },
  };
}
