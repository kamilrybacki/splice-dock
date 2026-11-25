import type { CredentialProviderConfig, CredentialStorageConfig } from '../../config/types.js';

/** Everything a provider may need to mint a credential for one identity. */
export interface MintContext {
  /** Profile the credential is issued for. */
  readonly profile: string;
  /** Agent label of the calling profile token, when the caller presented one. */
  readonly agent: string | null;
  /** Backend the credential is used against: an mcp_proxy namespace or a CLI tool name. */
  readonly backend: string;
  /** True only when the caller presented a valid profile-token bearer. Never part of a cache key. */
  readonly authenticated: boolean;
  /** Non-secret id of the caller's token, for audit only. Never part of a cache key. */
  readonly tokenId: string | null;
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

/**
 * Where minted credentials are persisted so a restart or another replica reuses them.
 * Keys are relative (`profile/backend/agent/provider`); any backend-specific
 * root such as a KV mount path belongs to the store implementation.
 */
export interface CredentialStore {
  get(path: string): Promise<StoredCredential | undefined>;
  put(path: string, value: StoredCredential): Promise<void>;
  delete(path: string): Promise<void>;
  /** Delete every entry under a path prefix. Returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
}

/** Who a credential is minted for. Part of every cache and storage key. */
export interface MintTarget {
  profile: string;
  agent: string | null;
  backend: string;
  /** Caller presented a valid profile-token bearer. Not part of any key. */
  authenticated: boolean;
  /** Non-secret token id, audit only. Not part of any key. */
  tokenId: string | null;
}

/**
 * Hands out minted credentials. Each instance owns its caches, single-flight
 * and backoff state, so two brokers never share anything.
 */
export interface CredentialBroker {
  /** Current value for (provider, profile, agent, backend), minting only when needed. */
  resolve(providerName: string, target: MintTarget): Promise<string>;
  /**
   * Best-effort revocation when a profile is deleted: provider revoke, then purge
   * shared storage, then drop local state. Run once, on the replica that served the delete.
   */
  revokeProfile(profile: string): Promise<void>;
  /**
   * Drop only this instance's in-process state for a profile (cache, mint records,
   * mint backoff). Never calls a provider or touches shared storage, so every other
   * replica can run it when it learns the profile is gone.
   */
  forgetProfile(profile: string): void;
}

/**
 * Infrastructure the credential broker needs, injected at startup so the
 * broker never imports a concrete provider or store.
 */
export interface CredentialAdapters {
  /** Build the provider for one `credential_providers` entry. */
  provider(config: CredentialProviderConfig): CredentialProvider;
  /** The store selected by `credential_storage`. */
  store(config: CredentialStorageConfig): CredentialStore;
}
