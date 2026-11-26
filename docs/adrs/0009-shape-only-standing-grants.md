# ADR 0009: Shape-Only Standing Grants with Deny-Only Context

**Date:** 2026-11-26
**Status:** Accepted (2026-11-26). Supersedes sections 3, 5 and 6 of ADR 0008.

## Context

ADR 0008 matched a standing grant on the exact operation shape **and** a similar
conversation context (TF-IDF cosine, `SPLICEDOCK_GRANT_CONTEXT_MIN_SIM` 0.5). We
measured that second requirement on a labelled set of context pairs:

- recall of genuinely equivalent reasons: **11.7%**, so almost every honest
  paraphrase fell back to manual approval and grants rarely helped;
- false matches between unrelated reasons: **3.2%**;
- an adversarial set (contexts written to look similar) scored the same as the
  honest set, so similarity added no protection against a caller that wants a match.

Context is written by the caller, which is the party the approval gate constrains.
Lexical similarity cannot tell an honest paraphrase from a crafted one, and lighter
learned models do not change that: whatever the caller controls cannot widen access.

## Decision

1. **The match key is the shape only**: `{profile, token_id, tool, verb_path,
   resource_kind, namespace, object_count_max, flags_allowed}` with exact equality,
   as in ADR 0008 section 1.
2. **Context is deny-only.** It is still required, stored and audited, and it can only
   send a request back to a human (`src/services/policy/context/escalation.ts`). A
   request escalates when its context, compared with every stored reference of the
   grant, carries no meaningful reason (empty, identifiers only, or more identifiers
   than terms), states a risky purpose (for example "so nobody notices", "without
   approval", "ignore previous instructions") that no reference stated, or
   contradicts any one of the references (before/after, same/different, old/patched).
   A neutral reference does not cover a contradiction with another reference.
3. **Promotion** happens after **3** executed manual approvals (default
   `SPLICEDOCK_GRANT_THRESHOLD`) of the same shape within 7 days. Evidence whose
   context escalates against another piece of evidence, in either direction, does
   not count. Consistency is not transitive ("before" and "after" can each agree
   with a neutral reason), so every pair in the evidence set must be consistent,
   not just each piece with the newest one.
4. **Lifetime**: TTL **3 days** from creation, at most **20** uses, no renewal.
   Grants stored under ADR 0008 are not migrated. They are held to the new limits
   when matched, claimed and promoted: they end at `min(expires_at, created_at +
   3 days)`, they stop at 20 uses, and they match only while they rest on at least
   threshold-many approvals. Fresh evidence collected after that effective expiry
   counts towards a replacement grant.
5. `SPLICEDOCK_GRANT_CONTEXT_MIN_SIM` is ignored; setting it logs a warning.

Unchanged: exceptions, the never-match list, the circuit breaker (3 failures),
revocation, and the 7-day promotion block after a rejection of the same shape.

## Consequences

- An honest caller gets a grant after three consistent approvals regardless of how
  it words its reasons.
- The exposure of a grant is bounded by the shape, 3 days and 20 uses, not by text
  analysis. The threshold, TTL and use cap were tightened to compensate for dropping
  the similarity requirement.
- The escalation rules are a small lexicon and will miss risky purposes phrased in
  other words. That is acceptable because they only add a human check on top of the
  shape boundary; they are never the reason a request runs.
