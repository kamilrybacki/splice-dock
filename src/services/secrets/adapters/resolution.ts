import type { CredentialSource } from '../../../config/types.js';
import { resolveMintedCredential, type MintTarget } from '../broker.js';
import { requireSecret } from './vault/guard.js';

/**
 * Resolve one credential binding. `from:` stays a plain reference resolved per
 * call; `mint:` asks the broker, which caches, persists and refreshes.
 */
export async function resolveCredentialSource(source: CredentialSource, target: MintTarget): Promise<string> {
  if ('from' in source) return requireSecret(source.from);
  return resolveMintedCredential(source.mint, target);
}
