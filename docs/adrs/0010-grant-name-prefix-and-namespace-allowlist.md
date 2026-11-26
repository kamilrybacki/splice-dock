# ADR 0010: Grant Name Prefix and Namespace Allowlist

**Date:** 2026-11-26
**Status:** Accepted (2026-11-26). Amends ADR 0009.

## Context

ADR 0009 matches a standing grant on the operation shape alone. For kubectl
`delete pod|job` the object names are not part of the shape, so after three
approvals of `delete job nightly-1 -n batch` the grant also auto-approves
`delete job prod-db-migrate -n batch`. A grant is broader than its evidence, and
it applies in any namespace. The operator priority is no false positives; a
missed automatic approval only costs a manual click.

## Decision

1. **Name prefix.** At promotion the evidence approvals' object names are read
   from `argv_json` through an optional per-tool `objectNames` hook on the shape
   registry (kubectl implements it; a tool without the hook never promotes). The
   grant stores `name_prefix`: the longest common prefix of all names, cut just
   after the last `-` or `.`. If there is no separator, or fewer than three
   characters precede it, no grant is created, the reason is logged, and promotion
   stays at the threshold. A grant matches only when `name_prefix` is non-null and
   every requested name starts with it. NULL never matches (this covers grants
   created before this ADR), and the atomic claim repeats the NULL check in SQL.
   Requests with no object names never match.
2. **Namespace allowlist.** `SPLICEDOCK_GRANT_NAMESPACES` lists exact namespaces,
   parsed in `env-config.ts`. Entries are trimmed, empties dropped, and each must
   match `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`; invalid entries are ignored with a
   warning. It is default-deny: empty means no grant forms or matches. The list is
   enforced at promotion, at match, and in the claim, so removing a namespace stops
   its grants immediately without deleting them. With `SPLICEDOCK_GRANTS=1` and an
   empty list a startup warning says grants are effectively off. The `<default>`
   namespace never matches.

## Consequences

- Grants are bounded by both a namespace and a name prefix drawn from what the
  operator actually approved. Mixed names shorten the prefix; unrelated names
  yield no grant.
- Existing deployments that enable grants must set the allowlist; existing grants
  have NULL prefixes and stop matching until relearned. Both are false negatives.
- One grant per identity still holds, so a second prefix for the same identity
  waits until the first ends; legacy NULL-prefix grants do not block promotion.
- Schema: `standing_grants.name_prefix TEXT` (SQLite migration, Postgres
  `ADD COLUMN IF NOT EXISTS`), shown in the admin grants list.
