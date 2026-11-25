# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `server.host` and `server.admin_host` choose the interface the MCP endpoint
  and the admin API bind to. The defaults keep the current behaviour (every
  interface), so nothing changes unless you set them. Outside a container, set
  `server.admin_host: 127.0.0.1` unless a reverse proxy on another host must
  reach the admin API.
- `type: command` credential providers accept `env_allowlist` (names copied
  from splicedock's environment) and `env` (`{ name, from }` references resolved
  at every mint). See the breaking change below.
- A startup warning is logged when `server.require_profile_token` is explicitly
  `false`.
- `createCredentialBroker(config, adapters)` returns a broker that owns its
  cache, single-flight, backoff and storage state, so two brokers share nothing.

### Changed

- **BREAKING (internal API):** the credential broker is an injected instance
  instead of module-level state. `configureCredentialBroker`,
  `resolveMintedCredential`, `revokeProfileCredentials`, `resetCredentialCache`
  and `resetCredentialBroker` are removed. `resolveCredentialSource`, `buildAuthHeaders`, `callHttpTool`, the CLI
  passthrough call functions, `McpProxyDriver` and `createMcpExpressApp`
  (`options.credentials`) now take the broker, which `main.ts` creates once.
  Configuration files are unaffected.
- An `mcp_proxy` connection that uses a per-profile credential is now keyed by
  the calling agent as well as the profile, so callers of one profile with
  different agents no longer share a connection. "No agent" is encoded so that
  it cannot equal an agent named `_`. For the same reason the stored credential
  path for a caller without an agent is now `profile/backend/~/provider` instead
  of `.../_/...`; entries stored under the old segment are not reused and expire
  on their own, and deleting the profile still purges them.
- **BREAKING:** a `credential_providers` entry of `type: command` no longer
  runs with splicedock's whole environment. The command now starts with `PATH`,
  `HOME`, `LANG`, `LANGUAGE`, `LC_*`, `TZ` and `TMPDIR` only, so variables such
  as `VAULT_TOKEN`, `VAULT_ROLE_ID` or other backends' tokens are no longer
  visible to it. To migrate, add every variable your command reads to the new
  `env_allowlist: [NAME, ...]` on that provider (for the shipped scripts:
  `VAULT_ADDR`, `VAULT_TOKEN` and `SPLICEDOCK_VAULT_*` for `vault-token.mjs`;
  `GITHUB_APP_*` and `GITHUB_API_BASE` for `github-app-token.mjs`). Proxy and CA
  variables such as `HTTPS_PROXY` or `SSL_CERT_FILE` need listing too. A secret
  only the minter needs can instead be declared as `env: [{ name, from }]`,
  resolved from `env:` / `vault:` at every mint. There is no option to inherit
  everything.
- Minted credentials now have a hard lifetime cap. `credential_providers.<name>.max_ttl_seconds`
  (default 86400, at most 2592000) bounds how long the broker keeps a credential
  after minting, whatever expiry the provider reports; a later expiry, or none,
  is replaced by the cap and logged as `credential lifetime capped`. A stored
  entry that was issued for longer than the cap, or records no lifetime, is
  reminted instead of reused. **Migration:** a
  `command` provider with `ttl_seconds` above 86400 now needs `max_ttl_seconds`
  at least as large, because `ttl_seconds` must not exceed it.
- A failed credential mint now backs off per profile, agent, backend and
  provider instead of running the provider again on every call. The window
  starts at 1s, doubles on each consecutive failure up to 60s, and has up to
  25% jitter. Calls inside it fail immediately with the new error code
  `credential_mint_backoff` (the first failure still reports
  `credential_unavailable`). A successful mint resets it. Identity refusals are
  not affected.
- **BREAKING:** `server.require_profile_token` now defaults to `true`. `POST /mcp`
  requires a valid profile-token bearer and ignores `?profile=`; a request
  without one gets HTTP 401 (`profile_token_required`). To migrate, create a
  profile token for each client (`POST /api/v1/profile-tokens`) and send it as
  `Authorization: Bearer <token>`, or keep the old behaviour with
  `server.require_profile_token: false`. The `Deprecation` header on `?profile=`
  sessions is now a fixed RFC 9745 date and only appears under that opt-out.
- Credential minting now requires an authenticated caller (a valid profile
  bearer token). Sessions that select a profile without a bearer token
  (`?profile=` or the default profile) no longer receive minted credentials and
  get `credential_identity_unauthenticated`. This applies to CLI passthrough,
  HTTP tools and `mcp_proxy` upstreams with `mint:` auth; the `mcp_proxy` check
  runs on every call, independent of which session opened the shared upstream
  connection. Static `from:` credentials are unaffected. The "credential
  minted" log line now includes `token_id`, taken from the current caller.
  When a lazy `mcp_proxy` connect is refused for this reason, the call now
  returns `credential_identity_unauthenticated` instead of "No proxy driver".

### Fixed

- Deleting a profile now clears its in-process credential cache, mint records and mint backoff on every replica, not only the one that served the delete. Provider revocation and the shared-store purge still run once, on the serving replica.
- Tool and upstream definitions added through the admin API, and stored runtime rows reloaded at startup, now reject a tool-level `mint:` exactly as the config loader does.
- A `cli_passthrough` tool no longer returns the credentials it injected.
  Before stdout, stderr or an error message is returned, every literal
  occurrence of a value placed in the child's environment (minted or static
  `env:` / `vault:` references, plus any variable whose name contains `TOKEN`,
  `SECRET`, `PASSWORD`, `CREDENTIAL`, `API_KEY` and similar) is replaced with
  `[REDACTED]`. The scrub runs on the assembled output, so a value split across
  stream chunks is covered. Values shorter than 8 characters are left alone.
  Only literal occurrences are detected: a credential the CLI re-encodes
  (base64, hashing) is not. **Migration:** a script that read a credential back
  out of a tool result now gets `[REDACTED]`.
- gh invocations that exist to print a credential are refused before the CLI
  spawns, with the error `credential_print_denied:<rule id>`: `gh auth token`,
  `gh auth status --show-token` / `-t`, and any `--jq` / `-q` expression that
  reads the environment (`env`, `$ENV`). The rules are data on the CLI profile
  (`credentialDenies`), so other CLIs can add their own.

## [1.1.1] - 2026-11-24

### Changed

- The MCP endpoint runs on Express 5 (was 4) and the admin server rate limiter
  on `@fastify/rate-limit` 11 (was 10).
- Dependency updates: fastify 5.12, `@simplewebauthn/server` 14.1.0,
  `@fastify/sensible` 6.0.8 and minimatch 11.0.9.
- CI uses actions/checkout 7, actions/setup-node 7 and current Docker
  actions.

### Fixed

- The gateway waits for policy and approval setup before accepting MCP calls.
- CLI install scripts can write to stdout without blocking on an unread pipe.
- The example configuration installs a checksum-verified GitHub CLI on both
  Linux amd64 and arm64.
- The example configuration (`splicedock.example.yaml`) now loads: `mcp_proxy`
  entries use `service_dns`, `port` and `transport` instead of the unsupported
  `upstream`, and a `consent` block with `rp_id` and `origin` is included.
- The README install commands for npm and the container set
  `SPLICEDOCK_ADMIN_TOKEN`, without which the gateway does not start. The npm
  commands also use a writable npm prefix, copy the example into place, and set
  `SPLICEDOCK_BIN` to a directory the user can write to; the default
  `/var/splicedock/bin` stopped startup with `EACCES` for a non-root user.
- The example configuration lists `gh` and `codex` in `cli_whitelist`. With the
  empty list every call to its two CLI tools was refused.
- `cli_passthrough` install scripts no longer inherit `NPM_CONFIG_PREFIX` or
  `NPM_CONFIG_CACHE` from the gateway's environment. With either set,
  `npm install -g` in a script could install outside `SPLICEDOCK_BIN` and the
  tool was reported as failed.
- The MCP endpoint answers malformed, oversized and unknown requests with JSON
  instead of Express's HTML error page, which could include a stack trace, and
  no longer sends the `X-Powered-By` header.
- `GET` and `DELETE` on `/mcp` return 405 with `Allow: POST` instead of 404,
  as the MCP Streamable HTTP transport expects from a server without sessions.
- The MCP server reports the package version instead of `1.0.0`.

## [1.1.0] - 2026-11-24

### Added

- End-to-end smoke tests in `scripts/smoke/`. CI installs the packed npm
  package in a fresh container and runs the Quickstart against it, and on pull
  requests starts the built image with SQLite and with PostgreSQL.

### Changed

- The image runs the gateway as the `node` user (UID 1000) instead of root.
  When started as root, the entrypoint gives `/var/splicedock/data` and
  `/var/splicedock/bin` to that user, including volumes written by v1.0.0,
  then drops privileges. Files mounted into the container must be readable by
  UID 1000. Without `CAP_SETUID` and `CAP_SETGID` (for example
  `--cap-drop ALL`) it logs a warning and keeps running as root. `--user` and
  Kubernetes `runAsUser` work as before.
- The image pins uv 0.13.9 by digest and the codex CLI to 0.172.0; it used to
  install the latest of each and ignore a failed codex install.
  `/root/.local/bin` is no longer on `PATH`.

## [1.0.0] - 2026-11-24

First public release.

### Added

- npm package `splicedock` with a `splicedock` command. Run it with
  `npx splicedock` or install it with `npm install -g splicedock`.
  `splicedock db migrate-sqlite-to-pg` runs the SQLite to PostgreSQL migration.
- Container images on GHCR for `linux/amd64` and `linux/arm64` for each
  release tag, with an SBOM and build provenance.
- GitHub releases with generated notes for each `vX.Y.Z` tag.
- The user guide is published from this repository at
  <https://kamilrybacki.github.io/splice-dock/>.

### Changed

- `better-sqlite3` upgraded to 13, which ships prebuilt binaries for current
  Node.js versions. npm still starts a `node-gyp` build for it
  ([npm/cli#9837](https://github.com/npm/cli/issues/9837)); the image skips
  it, and on a machine without Python and a C++ compiler
  `npm install -g splicedock --ignore-scripts` works.
- CI runs only on GitHub-hosted runners.

### Removed

- **Breaking:** compatibility with the former project name. The gateway no
  longer reads `CELLARETTE_*` environment variables and no longer accepts the
  `X-Cellarette-CSRF` or `X-Cellarette-Authelia` headers. Use `SPLICEDOCK_*`,
  `X-Splicedock-CSRF` and `X-Splicedock-Authelia`.

[Unreleased]: https://github.com/kamilrybacki/splice-dock/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/kamilrybacki/splice-dock/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/kamilrybacki/splice-dock/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/kamilrybacki/splice-dock/releases/tag/v1.0.0
