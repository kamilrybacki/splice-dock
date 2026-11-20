// Per-request caller identity, propagated with AsyncLocalStorage so deep
// layers (the approval hook) can bind to the caller without threading
// parameters through the MCP SDK. `tokenId` is a stable NON-secret id (a
// truncated hash of the bearer, or "legacy-query" for ?profile= selection).
// `authenticated` is true only when the caller presented a valid profile-token
// bearer; approval flows refuse every caller where it is false.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface CallerIdentity {
  profile: string;
  tokenId: string;
  /** True only for a caller authenticated by a profile-token bearer. */
  authenticated: boolean;
  /** Operator-set agent label of the bearer's token, when it carried one. */
  agent?: string | null;
}

/** token_id used when the profile came from the legacy ?profile= query. */
export const LEGACY_QUERY_TOKEN_ID = 'legacy-query';

const als = new AsyncLocalStorage<CallerIdentity>();

export function runWithCaller<T>(caller: CallerIdentity, fn: () => T): T {
  return als.run(caller, fn);
}

export function currentCaller(): CallerIdentity | undefined {
  return als.getStore();
}
