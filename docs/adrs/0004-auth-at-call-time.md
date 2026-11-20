# ADR 0004: Auth Resolved at Call Time, Never Cached

**Date:** 2026-04-14  
**Status:** Accepted

## Context

Tools may require credentials: a GitHub Bearer token, a basic-auth password, or a custom HTTP header value. These credentials are referenced in tool configs as `env:VARIABLE_NAME` or `vault:path/to/secret`. The question is when and how long to hold resolved credential values.

## Decision

Resolve auth references **at the moment of each tool call** (`callHttpTool`, `callCliTool`) and **never cache** the resolved value across calls.

## Rationale

1. **Secret rotation**: If a Vault secret is rotated mid-operation, a cached value would remain valid until the cache expires — potentially hours. Call-time resolution ensures the latest secret is always used.

2. **No in-memory secrets**: Caching secrets in a `Map` or module-level variable creates a longer window during which a memory dump, heap snapshot, or accidental log could expose the value. Resolving on-demand means the secret lives in memory only for the duration of the HTTP request or CLI process.

3. **Vault lease management**: Vault KV v2 secrets have no leases, so there is no lease renewal problem. Call-time reads are always fresh and do not require a lease management loop.

4. **Simplicity**: The resolver (`src/auth/resolver.ts`) is a single pure async function with no state. There is no invalidation logic, no TTL management, and no race condition between cache eviction and a concurrent call.

## Consequences

- **Positive**: No secret leakage through caching; automatic rotation support; simpler codebase.
- **Negative**: Each tool call incurs an extra HTTP round-trip to Vault (for `vault:` references). At typical call rates (<10 RPS) this is negligible. For `env:` references the overhead is zero.
- **Neutral**: The `VAULT_ADDR` environment variable must be set at startup for Vault auth to work; missing it fails the first `vault:` resolution with a clear error.
