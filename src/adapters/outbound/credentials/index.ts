import type { CredentialAdapters } from '../../../ports/credentials.js';
import { createCommandProvider } from './providers.js';
import { VaultCredentialStore } from './store.js';

/** Production wiring for the credential broker. */
export const credentialAdapters: CredentialAdapters = {
  provider(config) {
    switch (config.type) {
      case 'command':
        return createCommandProvider();
    }
  },
  vaultStore: prefix => new VaultCredentialStore(prefix),
};
