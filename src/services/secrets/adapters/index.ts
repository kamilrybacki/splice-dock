import type { CredentialAdapters } from '../base.js';
import { createCommandProvider } from './command/provider.js';
import { VaultCredentialStore } from './vault/store.js';

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
