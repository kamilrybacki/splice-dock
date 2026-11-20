import type { CredentialProviderConfig } from '../config/types.js';

/** Everything a provider may need to mint a credential for one identity. */
export interface MintContext {
  /** Profile the credential is issued for. */
  readonly profile: string;
  /** Agent label of the calling profile token, when the caller presented one. */
  readonly agent: string | null;
  /** Backend the credential is used against: an mcp_proxy namespace or a CLI tool name. */
  readonly backend: string;
  /** Declared `credential_providers` instance name (the `mint:` value). */
  readonly provider: string;
  /** Parsed config of that provider instance. */
  readonly config: CredentialProviderConfig;
}

export interface MintedCredential {
  /** The credential value itself. Never logged. */
  secret: string;
  /** Epoch ms. Absent → the broker applies the provider's `ttl_seconds`. */
  expiresAt?: number;
  /** Non-secret descriptive fields persisted and cached alongside. */
  metadata?: Record<string, string>;
}

/** A way to obtain a credential for a service. One adapter per minting surface. */
export interface CredentialProvider {
  mint(ctx: MintContext): Promise<MintedCredential>;
  /** Best-effort revocation when the profile disappears. Must not throw. */
  revoke?(ctx: MintContext, minted: StoredCredential): Promise<void>;
}

export interface StoredCredential {
  value: string;
  /** Epoch ms. Absent means the value was minted without a reported expiry. */
  expiresAt?: number;
  /** Lifetime at mint time, used to size the refresh window consistently. */
  ttlMs?: number;
  provider: string;
  metadata?: Record<string, string>;
}

/** Where minted credentials are persisted so a restart or another replica reuses them. */
export interface CredentialStore {
  get(path: string): Promise<StoredCredential | undefined>;
  put(path: string, value: StoredCredential): Promise<void>;
  delete(path: string): Promise<void>;
  /** Delete every entry under a path prefix. Returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
}

/**
 * Infrastructure the credential broker needs, injected at startup so the
 * broker never imports a concrete provider or store.
 */
export interface CredentialAdapters {
  /** Build the provider for one `credential_providers` entry. */
  provider(config: CredentialProviderConfig): CredentialProvider;
  /** A persistent store rooted at a Vault KV v2 data path. */
  vaultStore(prefix: string): CredentialStore;
}
