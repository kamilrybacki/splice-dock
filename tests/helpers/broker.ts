import { credentialAdapters } from '../../src/services/secrets/adapters/index.js';
import { createCredentialBroker } from '../../src/services/secrets/broker.js';
import type { CredentialBroker } from '../../src/services/secrets/base.js';
import type { CredentialProviderConfig } from '../../src/config/types.js';

/** A broker that refuses to mint: for tests whose subject never resolves a `mint:` reference. */
export function unusedBroker(): CredentialBroker {
  return {
    async resolve(providerName: string): Promise<string> {
      throw new Error(`unexpected credential resolve for "${providerName}"`);
    },
    async revokeProfile(): Promise<void> {},
    async forgetProfile(): Promise<void> {},
  };
}

/** A real broker over the in-memory store with the given provider instances. */
export function memoryBroker(
  providers: Record<string, CredentialProviderConfig> = {},
): CredentialBroker {
  return createCredentialBroker(
    { providers, storage: { type: 'memory', prefix: '' } },
    credentialAdapters,
  );
}
