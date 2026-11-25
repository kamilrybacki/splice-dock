import type { CredentialSource } from '../../../config/types.js';
import type { CredentialBroker, MintTarget } from '../base.js';
import { requireSecret } from './vault/guard.js';

/**
 * Resolve one credential binding. `from:` stays a plain reference resolved per
 * call; `mint:` asks the broker, which caches, persists and refreshes.
 */
export async function resolveCredentialSource(
  source: CredentialSource,
  target: MintTarget,
  broker: CredentialBroker,
): Promise<string> {
  if ('from' in source) return requireSecret(source.from);
  return broker.resolve(source.mint, target);
}
