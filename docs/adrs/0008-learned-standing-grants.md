# ADR 0008: Learned Standing Grants for Approval-Gated Operations

**Date:** 2026-11-01
**Status:** Accepted (2026-11-01)

## Context

Operations matched by `approval_subcommands` / `approval_subcommand_paths` create a
`pending_approvals` row and are refused until the operator approves them in the
WebUI. The agent then has to re-issue the same argv. The operator wants approvals that
recur in a similar context to stop interrupting them, while keeping the gate for
anything new or risky.

### What the history shows

Source: aggregate, read-only query of `pending_approvals` (all rows, about two months,
13 distinct days) and Loki/Mimir deny counters. Names, namespaces and nodes omitted.

| Tool / verb | Requests | Approved | Executed | Rejected | Expired |
|---|---:|---:|---:|---:|---:|
| `kubectl delete job(s)` | 16 | 3 | 0 | 0 | 16 |
| `linkedin_publisher publish` | 18 | 4 | 4 | 2 | 12 |
| `kubectl drain` | 1 | 1 | 1 | 0 | 0 |
| `kubectl cordon` | 1 | 0 | 0 | 0 | 1 |

Findings that drive this design:

1. **Volume is low.** The busiest shape repeats 16 times in two months. A rule like
   "auto-approve after 10 similar approvals" would almost never fire.
2. **Exact argv never repeats.** Every `kubectl delete job` names different jobs (11 of
   16 named three jobs at once). Matching on `argv_hash` / `op_digest` cannot learn
   anything. Matching must be done on the *shape* of the operation.
3. **Most friction is expiry, not the click.** 29 of 36 requests expired. Three
   `delete job` requests were approved (one about 6.5 h later) and still expired,
   because the agent had stopped waiting and never re-issued the call.
4. **Historical rows have no caller identity** (`profile`/`token_id` are null; they
   predate caller binding). Trusted fields cannot be reconstructed for old approvals,
   so history cannot count towards a grant.

## Decision

Add **standing grants**: an automatic permission for one operation *shape*,
bound to one caller, valid for **7 days**. Grants are created automatically once the
operator has approved the same shape in a similar conversation context a threshold
number of times. Exceptions (publishing, WebAuthn tools, configured verbs) are never
granted.

### 1. Operation shape (the match key)

A shape is derived only from trusted, server-side data. Nothing the agent writes
in free text goes into it.

```
shape = { profile, token_id, tool, verb_path, resource_kind, namespace,
          object_count_max, flags_allowed[] }
```

- `verb_path`: the matched approval subcommand (`delete`, `pr merge`, ...).
- `resource_kind`: normalised kind (`job`, `jobs` and `job.batch` become `job`).
- `namespace`: explicit `-n/--namespace` value. A missing namespace is its own value
  (`<default>`), never a wildcard.
- Object names are a **wildcard**. Count is capped (`object_count_max`, default 5).

**Never match** a grant (always fall back to the normal approval) when argv contains
any of: `--all`, `-A`/`--all-namespaces`, `-l`/`--selector`, `--field-selector`,
`--force`, `--grace-period=0`, `--now`, `--cascade=orphan`, `-f`/`--filename`,
`-k`/`--kustomize`, a `kind/name` token whose kind differs from the shape, or any flag
not in `flags_allowed` (default allow-list: `-n`, `--namespace`, `--wait`).

Shape extraction is a pure per-tool function (`src/services/policy/shape/<tool>.ts`). A tool
without one cannot have grants.

### 2. Eligibility and exceptions

Grants are allowed by default for every approval-gated tool that has a shape
extractor, **except** the exception list. The exception list is config
(`SPLICEDOCK_GRANT_EXCEPTIONS`, JSON array of `{tool, verb_path?}`) and the WebUI can
add or remove entries. Built-in exceptions that config cannot remove:

| Exception | Why |
|---|---|
| any `requireStrong` / WebAuthn tool (listed in `server.consent.strong_default_tools`) | strong consent is per operation by definition |
| `linkedin_publisher publish` (and any tool that publishes in the operator's name) | every post is unique content; operator decision 2026-11-01 |

_Update 2026-11-19: the LinkedIn publisher was removed, so the second row no longer
applies. A tool that publishes in the operator's name should still be added as an
exception._

Default config exceptions (removable): `kubectl drain`, `kubectl cordon`,
`kubectl uncordon` (rare, node-wide impact).

### 3. Automatic promotion

Operator decision 2026-11-01: no confirmation click. Once the threshold is crossed,
matching operations are approved automatically for 7 days.

- After an approval is **executed**, the service counts executed approvals in the
  last 7 days that have the **same shape** and a **similar context** (section 6).
- When the count reaches **`SPLICEDOCK_GRANT_THRESHOLD`** (default **2**), a grant
  is created automatically (`created_by='auto:<approval_id>'`), bound to the shape,
  including `profile` + `token_id`.
- The grant stores the contexts that produced it (`context_refs`), and later requests
  are compared against them.
- A **rejection** of a request with the same shape resets the counter, revokes any
  active grant for that shape and blocks auto-promotion of that shape for 7 days.
- Historical rows have no caller identity, so they never count towards a threshold.

### 4. Using a grant

In `ApprovalService.handle`, before inserting a `pending_approvals` row:

1. Compute the shape. If there is no shape, the tool is an exception, or argv hits
   the never-match list, use the normal flow.
2. Look up an active grant with the same shape (exact equality on every field),
   `object_count <= object_count_max` and a **context similar** to the grant's
   contexts (section 6). If the request has no context, there is no match.
3. On a hit, write a `pending_approvals` row with `status='approved'`,
   `consent_method='grant'`, `approved_by='grant:<id>'`, reserve and consume it in
   the same call. Execution, the audit trail and metrics stay the same.
4. Emit `ApprovalEvent` `grant_used` and increment
   `splicedock_approval_grant_used_total{tool,verb}`.

Visibility without push notifications: the WebUI approvals page gets an
"Automatic approvals" tab (active grants, uses, last use, revoke button) and a
history filter for `consent_method='grant'`.

### 5. Lifetime and revocation

- TTL **7 days** from creation, no silent renewal. A new grant is created only by
  crossing the threshold again after expiry.
- `use_count_max` (default 200) as a safety stop.
- Revoke one grant, or **revoke all** (WebUI button and an admin API route).
- Circuit breaker: if a grant-approved execution fails 3 times in a row, the grant
  is suspended.

### 6. Conversation context

Approval-gated tools get an optional `approval_context` input (at most 500
characters). The tool description tells agents to put in a one or two sentence
summary of why the operation is needed in this conversation. It is:

- stored on the `pending_approvals` row and shown on the approval page,
- used for promotion and matching as an **additional requirement** on top of an
  exact shape match.

Similarity in v1 is computed in process, with no external model call and no data
leaving the pod: normalised tokens (lowercase, digits, hex and UUID-like ids
collapsed, stop words dropped), TF-IDF over the stored contexts, cosine similarity.
Threshold `SPLICEDOCK_GRANT_CONTEXT_MIN_SIM` (default 0.5). "Similar to a grant" means
similarity to at least one of its `context_refs` is at or above the threshold. Every
decision logs the score, so the threshold can be tuned from data.

Security note: agent text is a prompt-injection surface. That is why context can only
**narrow** a match. The hard boundary is the server-side shape plus the exception
list, so a forged context can at most reproduce what an exact shape match already
allows.

### 7. Fix expiry (first PR)

The data says the largest convenience win is that approved requests never get
executed:

- Today the deny message only says "re-issue after approval", and agents give up.
  Add the `approval_id` to the deny message, plus an MCP tool
  `approvals__wait(id, timeout≤120s)` that returns `approved | rejected | expired |
  pending` so the agent can block until the decision.
- An approved row stays executable until its own `expires_at`, even if the agent
  re-issues late. Say so in the deny text.

### 8. Removal of the push notifier

Operator decision 2026-11-01: Splicedock sends no push notifications. The consent
notifier (`src/consent/notifier.ts`, `SPLICEDOCK_CONSENT_NOTIFY_URL`) is removed. The
consent link stays visible on the approval page and in the deny message.

## Schema

```sql
CREATE TABLE standing_grants (
  id               TEXT PRIMARY KEY,
  profile          TEXT NOT NULL,
  token_id         TEXT NOT NULL,
  tool             TEXT NOT NULL,
  verb_path        TEXT NOT NULL,
  resource_kind    TEXT NOT NULL,
  namespace        TEXT NOT NULL,
  object_count_max INTEGER NOT NULL DEFAULT 5,
  flags_allowed    TEXT NOT NULL,              -- JSON array
  created_at       INTEGER NOT NULL,
  created_by       TEXT NOT NULL,              -- 'auto:<approval_id>' or admin
  source_approval  TEXT,                       -- approval that triggered promotion
  context_refs     TEXT NOT NULL,              -- JSON array of approval ids
  expires_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  revoked_by       TEXT,
  suspended_at     INTEGER,
  use_count        INTEGER NOT NULL DEFAULT 0,
  use_count_max    INTEGER NOT NULL DEFAULT 200
);
CREATE INDEX standing_grants_lookup
  ON standing_grants (tool, verb_path, profile, token_id, expires_at);

ALTER TABLE pending_approvals ADD COLUMN shape_key TEXT;        -- canonical JSON
ALTER TABLE pending_approvals ADD COLUMN grant_id TEXT;
ALTER TABLE pending_approvals ADD COLUMN approval_context TEXT; -- agent summary

CREATE TABLE grant_exceptions (tool TEXT NOT NULL, verb_path TEXT NOT NULL DEFAULT '*',
  added_at INTEGER NOT NULL, added_by TEXT NOT NULL, PRIMARY KEY (tool, verb_path));
CREATE TABLE grant_blocks (shape_key TEXT PRIMARY KEY, until INTEGER NOT NULL);
CREATE INDEX pending_approvals_shape ON pending_approvals (shape_key, status, requested_at);
```

## Threat model

| Threat | Mitigation |
|---|---|
| Agent words the context to look like a past approval | Context only narrows; the hard boundary is the exact server-side shape |
| Agent widens a granted shape (`--all`, selector, another kind) | Never-match list plus a flag allow-list. Anything unknown falls back to manual approval |
| Stolen token reuses a grant | Grant bound to `profile` + `token_id`. Revoking the token kills its grants |
| Auto-grant for something risky | Exception list (built-in plus config), rejection revokes the grant and blocks the shape for 7 days |
| Grant forgotten | 7-day TTL, no renewal, WebUI tab, revoke-all |
| Runaway loop | `use_count_max`, circuit breaker, existing rate limits |

## Rollout

1. PR 1: expiry fix (`approval_id` in the deny message, `approvals__wait`) and removal
   of the push notifier.
2. PR 2: shape extractor for `kubectl`, `approval_context`, context similarity,
   grants, exceptions, WebUI tab. Enabled by `SPLICEDOCK_GRANTS=1`.
3. After two weeks, review similarity scores and the threshold.

## Consequences

- Positive: repeated, low-risk cleanups stop interrupting the operator. Each grant
  is visible, bounded and revocable. Expiry stops wasting approvals.
- Negative: a new table and per-tool shape extractors to maintain. A grant
  is broader than a single approval (any object names within the kind and namespace)
  and is created without a click, so the WebUI tab is the only place it is visible.
- Explicitly not done: any grant for publishing or WebAuthn-level tools, push
  notifications.

## Security constraints after implementation review

`GRANTABLE_KUBECTL_PAIRS` is a closed allow-list: only `delete` on `pod`, `po`,
`pods`, `job`, or `jobs` can learn or match a grant. Object names are wildcarded,
so cluster-scoped resources (namespace/node/RBAC/CRD), `all`, dotted API-group
kinds, secrets, configmaps, PVCs, serviceaccounts, and all `exec` operations must
return no shape. Namespace flags do not confine cluster-scoped resources; exec
command words are arbitrary code and must never be wildcarded as object names.

Promotion requires a recorded exit-zero result, not merely spawn/consumption.
Only rows shaped while grants are enabled qualify. Rejections block the base
caller/tool/verb/kind/namespace for seven days even for ungrantable flag variants;
evidence from before rejection cannot promote after the block lifts. Grant-backed
reservations expire on pre-spawn release even if the feature is disabled meanwhile.
