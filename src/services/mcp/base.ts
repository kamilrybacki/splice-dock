import { hashProfileToken } from '../authentication/base.js';

export interface ResolvedProfileBinding {
  /** The bound profile when a valid bearer was presented; otherwise null and
   *  the caller keeps the legacy ?profile= behavior. */
  profile: string | null;
  /** True when a bearer was presented but resolved to no profile. The caller
   *  MUST reject with 401 and MUST NOT fall back to ?profile=. */
  unauthorized: boolean;
  /** Stable non-secret id of the bearer (truncated hash); null without a valid bearer. */
  tokenId?: string | null;
  /** Operator-set agent label of the bearer's token; null/undefined when none. */
  agent?: string | null;
}

/**
 * Resolve a profile binding from an Authorization header. A `Bearer <token>`
 * is looked up via `lookup`: a hit binds that profile (the caller then ignores
 * the ?profile= query); a miss is unauthorized. Any other or absent
 * Authorization is a no-op, leaving the caller on the legacy ?profile= path.
 */
export type ProfileTokenLookup = (rawToken: string) => ProfileTokenMatch | Promise<ProfileTokenMatch>;
type ProfileTokenMatch = string | { profile: string; id: string; agent?: string | null } | null;

export async function resolveBoundProfile(
  authHeader: string | undefined,
  lookup: ProfileTokenLookup,
): Promise<ResolvedProfileBinding> {
  if (typeof authHeader !== 'string') return { profile: null, unauthorized: false };
  const match = /^Bearer\s+(.+)$/.exec(authHeader.trim());
  if (!match) return { profile: null, unauthorized: false };
  const token = match[1].trim();
  if (!token) return { profile: null, unauthorized: false };
  const result = await lookup(token);
  const profile = typeof result === 'string' ? result : result?.profile;
  return profile
    ? {
        profile,
        unauthorized: false,
        tokenId: typeof result === 'object' && result ? result.id : `tok-${hashProfileToken(token).slice(0, 16)}`,
        ...(typeof result === 'object' && result && { agent: result.agent }),
      }
    : { profile: null, unauthorized: true };
}
