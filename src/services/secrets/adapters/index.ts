import type { CredentialAdapters } from '../base.js';
import { MemoryCredentialStore } from '../memory/store.js';
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
  store(config) {
    switch (config.type) {
      case 'vault':
        return new VaultCredentialStore(config.prefix);
      case 'memory':
        return new MemoryCredentialStore();
    }
  },
};
