export type ProfileSelectionSource = 'bearer' | 'query' | 'none';

/** A given profile is warned about at most once per this window. */
export const QUERY_FALLBACK_WARN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Returns a function that emits a deprecation warning for a profile selected
 * through the unauthenticated ?profile= query, deduped per profile name.
 * Only the profile name is ever passed on; no token or header value.
 */
export function createQueryFallbackWarner(
  emit: (profile: string) => void,
  now: () => number = Date.now,
): (profile: string) => void {
  const lastWarned = new Map<string, number>();
  return profile => {
    const t = now();
    const prev = lastWarned.get(profile);
    if (prev !== undefined && t - prev < QUERY_FALLBACK_WARN_INTERVAL_MS) return;
    lastWarned.set(profile, t);
    emit(profile);
  };
}
