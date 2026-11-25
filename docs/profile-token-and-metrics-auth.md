# Profile-token enforcement and /metrics auth

## Require a profile token

`server.require_profile_token` defaults to `true`. Create a token for the
intended profile and send it as `Authorization: Bearer <profile-token>` on
requests to `POST /mcp`. The token selects its bound profile, and the
`?profile=` query parameter is ignored. The gateway returns HTTP 401 when the
token is missing or invalid.

### Opting out

Set `server.require_profile_token: false` to allow the unauthenticated
`?profile=<name>` selection again. Any caller that can reach the MCP port can
then pick any profile, so use it only on a trusted network. The gateway logs a
warning at startup when the option is `false`, and each `?profile=` session
carries a `Deprecation` response header and a log line.

### Migrating from earlier versions

Earlier versions defaulted to `false`. After upgrading, a client that connected
with `?profile=<name>` and no bearer token receives HTTP 401
(`profile_token_required`). Either create a profile token for each client
(`POST /api/v1/profile-tokens`) and send it as a bearer, or add
`require_profile_token: false` to `server:` to keep the old behaviour.

## Bind addresses

| Key | Default | Listens on |
|-----|---------|------------|
| `server.host` | unset | MCP endpoint (`server.port`); unset binds every interface, as before |
| `server.admin_host` | `0.0.0.0` | Admin API and `/metrics` (`server.admin_port`) |

The defaults keep the previous behaviour (all interfaces). Outside a container,
set `server.admin_host: 127.0.0.1` unless a reverse proxy on another host must
reach the admin API. Inside a container leave it as is, or the published port
is unreachable.

See [MCP clients and tokens](https://kamilrybacki.github.io/splice-dock/connect.html#create-token)
for a token-creation example.

## `server.metrics_token_env` (default `SPLICEDOCK_METRICS_TOKEN`)

Names the env var holding the scrape token. If it is set and non-empty,
`GET /metrics` on the admin port requires `Authorization: Bearer <token>`
(constant-time compare) and answers 401 otherwise. If unset, `/metrics` is
unauthenticated. The admin token is not accepted there. Update the
Prometheus scrape config with `authorization.credentials` before setting it.

## Agent label

`POST /api/v1/profile-tokens` accepts an optional `agent` (`^[a-zA-Z0-9_-]{1,64}$`, else 422). It is stored with the token, kept on rotation, returned by create/list, and logged as `agent` on every `tool call` line (falls back to the profile name when unset). MCP `clientInfo` name/version are logged separately as the informational `client` / `client_version`.

To label an existing token without changing its secret (running agents keep working), `PATCH /api/v1/profile-tokens/:id` with `{"agent": "<label>"}` or `{"agent": null}` to clear it. Returns 200 with `{id, profile, agent}`, 400 when `agent` is missing, 422 for an invalid label, 404 for an unknown, revoked or expired token. Logged as a `token lifecycle` event `relabelled`.

## Per-profile credentials

By default a backend credential is declared once on the tool
(`tools[].auth` for `mcp_proxy`, `tools[].env` for `cli_passthrough`) and is
therefore shared by every profile — one upstream identity, one CLI identity.
`profiles.<name>.credentials.<tool>` binds a different credential to one
profile:

```yaml
profiles:
  worker:
    tools: ["vault__*", "gh__*"]
    credentials:
      vault:                       # mcp_proxy: same shape as tools[].auth
        auth:
          type: bearer
          token: { from: vault:secret/data/splicedock#worker_vault_token }
      gh:                          # cli_passthrough: replaces same-named env refs
        env:
          - name: GH_TOKEN
            from: vault:secret/data/github#worker_pat
```

Each entry sets exactly one of `auth` or `env`, matching the tool's type.

- `mcp_proxy` and `http`: a profile with `auth` gets its **own credential**;
  for `mcp_proxy` that means its own upstream connection,
  keyed `backend\0profile` in the shared driver map. Without `auth` the driver
  is shared under the bare backend name. A driver carries exactly one
  credential, so a profile never reuses a connection opened for another.
  Fail-closed: if the override cannot be honoured (no `proxyConfigs`/resolver),
  the call errors instead of falling back to the shared driver.
- `cli_passthrough`: the profile's `env` entries replace same-named entries of
  the tool's `env` and may add new ones. Ref resolution already happens per
  call, so no restart is needed after a rotation.
- Tool discovery at startup (`ToolRefreshService.probeOnce`) still uses the
  tool-level credential, so it must be valid enough to list tools.
- A credential key that names no tool, or uses the wrong shape, fails startup —
  a typo must not silently keep the shared credential.

## Minted credentials

A `from:` binding points at a value that already exists. A `mint:` binding asks
a provider for a fresh credential for the calling identity, so a new service or
a new profile needs no pre-created secret. Both forms live in the same places:

```yaml
credential_providers:
  gh:                                  # an instance name, referenced by mint:
    type: command
    command: /usr/local/bin/mint-gh
    args: ["--profile", "{profile}", "--agent", "{agent}"]
    timeout_ms: 10000
    ttl_seconds: 3000
    max_ttl_seconds: 86400             # hard cap on how long any minted credential is kept
    output: { format: json, secret_field: token, expires_in_field: expires_in }

credential_storage:
  type: vault                          # default
  prefix: secret/data/splicedock/minted

credential_defaults:                   # applies to ANY profile without its own entry
  gh:
    env:
      - name: GH_TOKEN
        mint: gh

profiles:
  worker:
    tools: ["gh__*", "vault__*"]
    credentials:
      vault:
        auth:
          type: bearer
          token: { mint: gh }          # same provider, different backend
```

### How a mint resolves

1. **L1 memory** cache keyed by `(profile, agent, backend, provider)`.
2. **L2 store** — Vault KV v2 at `<prefix>/<profile>/<backend>/<agent>/<provider>`.
   A restart or another replica reuses the entry instead of minting again.
3. **Mint** via the provider, then write L2 and L1.

- Resolution is **single-flight**: concurrent callers for one key share one mint.
- Refresh happens at 10% of the credential's actual lifetime before expiry
  (capped at 60s), using the provider's reported expiry when it gives one and
  `ttl_seconds` otherwise.
- **Lifetime cap.** A credential is never kept past `max_ttl_seconds` (default
  86400, at most 2592000) after it was minted, whatever the provider reports. A
  later expiry, or none, is replaced by the cap, and the broker logs
  `credential lifetime capped` with the reported and effective expiry (never the
  value). `ttl_seconds` must not exceed `max_ttl_seconds`; a config where it
  does fails to load. A stored (L2) entry is reused only if it records a
  lifetime (`ttl_ms`) within `max_ttl_seconds` and ends no later than that from
  now (plus a one-minute allowance for clock skew between replicas). Anything
  else was not written under the cap, so the broker logs
  `credential store entry exceeds max_ttl; reminting` and mints again, which
  overwrites the entry.
- A failed mint is **not retried immediately**. The key (same as the L1 key)
  backs off for 1s, doubling on each consecutive failure up to 60s, with up to
  25% jitter taken off each window. Calls inside the window fail at once with
  `credential_mint_backoff` and do not run the provider; the first call after it
  tries again. A successful mint resets the backoff, and so does deleting the
  profile; so does a quiet period, because a key that has gone more than 60s
  past its window without a new failure starts again from 1s. The window is not configurable. Identity refusals are never part of
  it.
- Every failure is **fail-closed**: `unknown_credential_provider`,
  `credential_unavailable`, `credential_mint_backoff`,
  `credential_identity_missing` or `credential_identity_unauthenticated` —
  never a fallback to the shared tool-level credential.
- If the store is unreachable the credential still works from L1; the write and
  read failures are logged and the value is simply not reused across restarts.
- Deleting a profile revokes at the provider (when it implements `revoke`) and
  purges `<prefix>/<profile>` from the store.

### The generic provider

`type: command` is deliberately service-agnostic: any CLI that prints a
credential can mint for any service, so adding a backend needs no code. Argv
templates `{profile}`, `{agent}`, `{backend}` and `{provider}` are substituted
inside a single argv element (`shell: false`), so values can never split into
extra arguments or reach a shell.

The command is trusted operator config and runs with splicedock's privileges,
including its environment. Treat a `credential_providers` entry like a
`cli_passthrough` install script: whoever can write the config can run code and
mint identities the provider is allowed to mint.

`mint:` is refused on tool-level `auth` and tool-level `env` — both are
resolved without a profile identity (startup install, tool discovery).

### Backends behind `mcp-bridge`

An `mcp_proxy` backend reached through `mcp-bridge` >= 0.7.0 accepts a
per-session credential: on the `initialize` request the bridge honours
`X-Mcp-Env-<VAR>: <value>` for any `<VAR>` listed in that bridge's
`MCP_ALLOWED_ENV`, and starts the session's child process with it (one child per
session, so values never cross callers). `SHARED_UPSTREAM` bridges refuse the
header outright.

That makes a backend credential a normal `mint:` binding:

```yaml
credential_providers:
  vault_token:
    type: command
    command: node
    args: ["/app/scripts/mint/vault-token.mjs", "{profile}", "{agent}", "{backend}"]
    output: { format: json, secret_field: token, expires_in_field: expires_in }

credential_defaults:
  vault:
    auth:
      type: header
      name: X-Mcp-Env-VAULT_TOKEN
      value: { mint: vault_token }
```

The `/app/scripts/mint/` paths are for the container image. With the npm
package, the scripts are in `$(npm root -g)/splicedock/scripts/mint/`.

A harness that rotates a backend credential must re-open the session: splicedock
does this automatically when the resolved headers differ from the ones the
session was opened with (`McpProxyDriver` compares a hash, never the value).

### GitHub installation tokens

`GH_TOKEN` can only be minted through a **GitHub App**: fine-grained PATs have
no issuing API, and an Actions Runner Controller App cannot be reused — its
permissions are `actions:read`, `administration:write`, `metadata:read`, so it
cannot touch repos, issues or pull requests.

Create a dedicated App (Settings → Developer settings → GitHub Apps → New):

- Webhook: off. Homepage URL: anything (the admin host is fine).
- Repository permissions: **Contents** RW, **Issues** RW, **Pull requests** RW,
  **Actions** RW, **Commit statuses** R, **Checks** R, **Metadata** R
  (mandatory). Add **Workflows** RW only if agents may edit workflow files, and
  **Projects** RW only for Projects v2.
- Account permissions: none. Install scope: only this account.
- Create, generate a private key, then install the App on the account.

Store the material where splicedock can read it, e.g.
`vault kv put secret/github/splicedock-app app_id=… private_key=@key.pem installation_id=…`
and expose it to the pod as `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_APP_INSTALLATION_ID` (an ExternalSecret plus `extraEnv`, same pattern as
the other secrets). Then bind it:

```yaml
credential_providers:
  github_app:
    type: command
    command: node
    args: ["/app/scripts/mint/github-app-token.mjs", "{profile}", "{agent}", "{backend}"]
    ttl_seconds: 3600
    max_ttl_seconds: 86400
    output: { format: json, secret_field: token, expires_in_field: expires_in }

credential_defaults:
  gh:
    env:
      - name: GH_TOKEN
        mint: github_app
```

Keep the static `GH_TOKEN` in `extraEnv`: startup install scripts still use it
for rate-limited downloads, while every tool invocation gets the minted,
1-hour installation token. Installation tokens carry the App's identity, not the
profile's — per-agent GitHub identities would need one App per agent.
