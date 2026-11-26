# Operate Splicedock

## Learned standing grants

`SPLICEDOCK_GRANTS=1` enables ADR 0008 standing grants; the default is off.
Approval-gated CLI calls accept `approval_context` (at most 500 characters): one
or two sentences explaining why this conversation needs the operation. Without
context, requests always require manual approval and cannot teach a grant.

After `SPLICEDOCK_GRANT_THRESHOLD` executed manual approvals (default 3) of the
same caller-bound kubectl shape within seven days, matching operations can run
automatically (ADR 0009). The match key is the shape only. Context is stored and
audited, and it can only send a request back to a human: a request escalates when
its context carries no meaningful reason (empty, identifiers only or padded with
identifiers), states a risky purpose no stored context covered (for example "so
nobody notices", "skip the review", "ignore previous instructions"), or contradicts
any stored reference (before/after, same/different). Escalating approvals do not count
towards promotion. `SPLICEDOCK_GRANT_CONTEXT_MIN_SIM` is ignored; setting it logs a
warning. Unknown flags, bulk selectors and widened resource scopes fall back to
manual approval.

ADR 0010 narrows grants further. `SPLICEDOCK_GRANT_NAMESPACES` is a comma-separated
list of exact namespaces (for example `batch,ci-jobs`); entries are trimmed and must
be valid DNS-1123 labels, otherwise they are ignored with a warning. It is
default-deny: unset or empty means no grant forms or matches, and with
`SPLICEDOCK_GRANTS=1` a startup warning says grants are effectively off. The list is
checked at promotion and at every match, so removing a namespace stops its grants at
once. A grant also stores a `name_prefix`, the longest common prefix of the approved
object names cut after the last `-` or `.` (at least three characters before it).
It matches only when every requested name starts with that prefix. No usable prefix
means no grant; grants without a prefix never match.

Grants expire three days after creation without renewal, stop after 20 uses, and
suspend after three consecutive execution failures. Rejecting the same shape revokes
its grants and blocks promotion for seven days. Strong/WebAuthn tools are permanent
exceptions. Default removable
exceptions are kubectl drain, cordon and uncordon.
`SPLICEDOCK_GRANT_EXCEPTIONS` optionally replaces those defaults with a JSON array
of `{ "tool": "kubectl", "verb_path": "delete" }` entries (omit verb_path for all
verbs). Configuration is applied when changed; WebUI edits survive restart with
unchanged configuration.

Use **Approvals → Automatic approvals** to inspect uses, last use and expiry,
revoke one or all grants, and add/remove configurable exceptions. **Grant
history** filters grant-approved operations. Authenticated admin endpoints:
`GET /api/v1/grants`, `POST /api/v1/grants/:id/revoke` (id `all` revokes all),
and `POST /api/v1/grant-exceptions` (`tool`, optional `verb_path`, `remove`).
Cookie-authenticated mutations require the existing CSRF header.

Prometheus metrics count automatic approvals by tool and verb. Structured logs
include context similarity scores. Grant-reserved approvals that
fail before spawn expire instead of being refunded, so revocation cannot be
bypassed by retrying a released grant row. Such attempts still consume the grant
use budget.

For manual approvals, the refusal includes `approval_id` and `expires_at`.
Call `approvals__wait` with `{ "id": "<approval_id>", "timeout_s": 120 }`, then
retry the same argv and cwd using the same profile token. Approved requests remain
executable until their own expiry. MCP clients get no push notification; poll
with `approvals__wait`.

## Per-profile policy overrides

For `cli_passthrough` tools, a policy can be overridden at runtime from the tool's page
(**Admin → Tools → tool**). Pick the scope at the top: **All profiles** edits the default,
a profile chip edits only callers on that profile (a dot marks scopes with their own override).
Resolution order: profile override, then the all-profiles override, then the file policy.
**Remove (inherit)** deletes the override at that scope. The API takes `?profile=<name>` on
`PUT`/`DELETE /api/v1/policies/:tool` and on `/dry-run`; an unknown profile returns 404.
Overrides are full replacements (not merged), persisted in `profile_policy_overrides`, and
propagate to other replicas through the policy invalidation channel and the reconcile poll.

## Phone approvals

`/admin/swipe` is an installable progressive web app (PWA): swipe right to approve,
left to reject. On your phone choose **Add to home screen** (Android: **Install
app**); it then opens full screen as *Splicedock approvals*.

| Asset | Path |
|-------|------|
| Web app manifest | `/admin/manifest.webmanifest` |
| Service worker | `/admin/sw.js` (scope `/admin/`) |
| Icons | `/admin/icon-180.png`, `icon-192.png`, `icon-512.png` |

The service worker is network-only and caches nothing, because approvals are live
state; it exists to make the app installable and to show Web Push alerts. These
assets carry no user data and are served without a session, while the edge proxy
still protects the admin host.

Tap **enable notifications** to get a Web Push alert for each new pending
approval (on iOS, add the app to the home screen first). Push is on only when
these env vars are set:

| Variable | Value |
|----------|-------|
| `SPLICEDOCK_VAPID_PUBLIC_KEY` | VAPID public key (`npx web-push generate-vapid-keys`) |
| `SPLICEDOCK_VAPID_PRIVATE_KEY` | VAPID private key |
| `SPLICEDOCK_VAPID_SUBJECT` | `https://` URL identifying the sender (e.g. the admin host) |

Without them the push endpoints return 404 and the button stays hidden. The
payload is generic (title plus tool name): no approval id, argv or consent link
leaves the cluster, and the click always opens `/admin/swipe`, where the normal
admin session and WebAuthn rules apply. Subscriptions live in SQLite
(`push_subscriptions`); push services are restricted to FCM, Apple, Mozilla and
Windows hosts, and subscriptions that return 404/410 are pruned.

## MCP upstreams

`mcp_proxy` upstreams can be declared in `splicedock.yaml` (type `mcp_proxy`) **or**
added at runtime: **Tools → Add tool → MCP server**, or `POST /api/v1/mcp-upstreams`
(`name`, `service_dns`, `port`, optional `transport`, `auth`). Tools are discovered
automatically and appear as `<name>__<tool>`; add them to a profile to use them.
Runtime upstreams persist in the DB and sync across replicas.

Because an operator-entered host makes the gateway open a connection, runtime
upstreams are **deny-by-default**: the host must match `server.mcp_upstream_allowlist`
(exact host, or `*.suffix` for subdomains, not the apex). A non-matching host returns
`403 host_not_allowed`. YAML-declared upstreams are exempt and read-only in the UI/API
(`409` on change). These routes sit behind the normal admin session/CSRF but have no
extra WebAuthn gate.

```yaml
server:
  mcp_upstream_allowlist: ["*.tools.svc.cluster.local"]
```

## Storage backend

Splicedock uses SQLite by default. Set `SPLICEDOCK_DB_PATH` to a writable database file, such as `./data/splicedock.db`.
Set `SPLICEDOCK_DB_DSN` to a `postgres://` / `postgresql://` URL to use Postgres instead; the schema is
created idempotently on start. SQLite must still run as a single replica. Tests: set
`SPLICEDOCK_TEST_PG_DSN` to also run the real-Postgres concurrency suite (skipped otherwise).

### Multi-replica cache invalidation (Postgres)

With 2+ replicas on one Postgres, an admin change to tools, profiles or policy on one replica is
announced via PostgreSQL notifications. Every other replica
re-reads from the DB. Delivery is best-effort: listeners resync fully after a reconnect, and a 30s
reconcile poll (content fingerprint of the three tables) reloads anything that drifted. On SQLite
the bus is a no-op.

### Migrating SQLite data to Postgres

An existing SQLite deployment (profile tokens, approvals, grants, credentials, audit data) can be moved to
Postgres with a one-shot command. It copies every table, keeps ids and timestamps, repairs serial
sequences, runs in a **single transaction** (any failure rolls everything back) and verifies per-table row
counts before committing. Output lists table names and row counts only: never row contents or the DSN.

```sh
# 1. Stop the service so SQLite stops changing, and back up the .db file with its -wal / -shm companions.
# 2. Point SPLICEDOCK_DB_DSN at an empty database and run the migrator (build first: npm run build).
SPLICEDOCK_DB_DSN='postgres://USER:PASSWORD@HOST:5432/DBNAME' \
  node dist/main.js db migrate-sqlite-to-pg --sqlite /path/to/splicedock.db
# 3. Start the service with SPLICEDOCK_DB_DSN set. Existing profile tokens keep working: only their
#    hashes are stored, and they are copied unchanged.
```

- The target schema is created automatically. If it already contains data, the
  command refuses to proceed. `--force` replaces the target data with the SQLite
  snapshot.
- Splicedock opens the source database read-only. Before switching back to SQLite,
  stop writers and reconcile any changes accepted by PostgreSQL since cutover.
- Exit codes: `0` success, `1` refused or verification failed (nothing committed), `2` usage error,
  `3` unexpected failure (nothing committed; the message has the DSN password redacted).
