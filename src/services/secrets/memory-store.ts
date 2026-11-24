import type { CredentialStore, StoredCredential } from './base.js';

/** Process-local store. Default only for tests and `credential_storage.type: memory`. */
export class MemoryCredentialStore implements CredentialStore {
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
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key === prefix || key.startsWith(`${prefix}/`)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
