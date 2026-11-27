# ADR 0011: Typed Operation Classifier with Abstention

**Date:** 2026-11-27
**Status:** Proposed. Adds a module; nothing consumes it yet.

## Context

We tested light models as a layer that decides whether an operation is destructive
(synthetic set of 151 hand-labelled operations, leave-one-tool-out): frozen e5-small
embeddings, a 0.8B reader (laya), logistic regression on embeddings, TF-IDF and a
margin model. None gave zero leaks with a useful share of benign operations allowed.
A verb lexicon learned across tools was wrong in 10 of 46 decided cases, always because
the same verb has different impact on different objects (`delete pod` is recreated,
`delete secret` is not). Context lives in the verb, the object kind and the modifiers
(`--prune`, `--force`, HTTP DELETE), not in free text.

## Decision

1. `classifyOperation(tool, argv)` returns `benign | disruptive | destructive | unknown`
   plus a typed key `tool|verb|kind` and a reason.
2. Classes come only from a closed, human-written table per tool (`classify/tables.ts`).
   An unknown tool, verb, kind (for entries that close their kinds) or flag yields
   `unknown`. `unknown` is an abstention and must be treated as "needs a human".
3. Flags and kinds can only raise a class, except the explicit per-kind overrides in the
   table. `--force`, `--all`, `-A`, `--grace-period`, `--cascade`, HTTP DELETE raise to
   destructive.
4. New operations enter the table only by a human editing it; the key is the unit a
   review queue would present.

## Consequences

- No model is in the allow path. The classifier can only add caution.
- Coverage is small by design (kubectl and gh seed rows); missing rows are false
  negatives, never silent allows.
- Follow-up (not in this ADR): consume the class as a deny-only check at grant
  promotion and match, and a queue of `unknown` keys for operator review.


## Consumption (deny-only)

`classifierDeniesGrant` (`src/services/approvals/grants/standing.ts`) runs at grant promotion and at match. A shape classified `destructive` or `unknown` never forms or matches a grant and goes to a human; `benign` and `disruptive` are left to the existing shape rules. The classifier never authorizes anything. `kubectl delete job|jobs` is `disruptive` in the table so the grantable set of ADR 0009 keeps working.
