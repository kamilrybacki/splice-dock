import type { CredentialStore, StoredCredential, StoredCredentialEntry } from '../base.js';

/** Process-local store. Default only for tests and `credential_storage.type: memory`. */
export class MemoryCredentialStore implements CredentialStore {
  /** Entries never leave this process, so a sibling replica cannot see or purge them. */
  readonly shared = false;
  private readonly entries = new Map<string, StoredCredential>();

  async get(path: string): Promise<StoredCredential | undefined> {
    return this.entries.get(path);
  }

  async put(path: string, value: StoredCredential): Promise<void> {
    this.entries.set(path, value);
  }

  async delete(path: string): Promise<void> {
    this.entries.delete(path);
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = [...this.entries.keys()].filter(key => isUnder(key, prefix));
    for (const key of keys) this.entries.delete(key);
    return keys.length;
  }

  async listPrefix(prefix: string): Promise<StoredCredentialEntry[]> {
    return [...this.entries].filter(([key]) => isUnder(key, prefix)).map(([path, credential]) => ({ path, credential }));
  }
}

function isUnder(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(`${prefix}/`);
}
