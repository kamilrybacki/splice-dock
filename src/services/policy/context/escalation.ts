import { opposed } from './gates.js';
import { profile, RISK_PREFIX } from './normalize.js';

type Terms = ReadonlyMap<string, number>;
const risks = (terms: Terms): string[] => [...terms.keys()].filter(term => term.startsWith(RISK_PREFIX));

/** Meaningful terms of a text, or none when identifiers outnumber them (padding, not a reason). */
function meaningful(text: string): Terms | undefined {
  const { terms, identifiers } = profile(text);
  return terms.size && identifiers <= terms.size ? terms : undefined;
}

/**
 * Whether `candidate` asks for more than `reference` justified (ADR 0009). Context is
 * caller-written, so it can never widen a match: it only sends a request back to a
 * human. It escalates when it carries no meaningful reason, states a risky purpose
 * (such as "so nobody notices") the reference did not, or contradicts it (before vs
 * after, same vs different).
 */
export function escalates(candidate: string, reference: string): boolean {
  return judge(meaningful(candidate), meaningful(reference), candidate, reference);
}

function judge(a: Terms | undefined, b: Terms | undefined, candidate: string, reference: string): boolean {
  if (!a || !b) return true;
  return risks(a).some(term => !b.has(term)) || opposed(candidate, reference);
}

/**
 * `escalates` that normalises each distinct text once. For one batch of comparisons
 * (such as promotion evidence); the cache lives only as long as the returned function.
 */
export function escalationComparer(): (candidate: string, reference: string) => boolean {
  const parsed = new Map<string, Terms | undefined>();
  const terms = (text: string): Terms | undefined => {
    if (!parsed.has(text)) parsed.set(text, meaningful(text));
    return parsed.get(text);
  };
  return (candidate, reference) => judge(terms(candidate), terms(reference), candidate, reference);
}

/**
 * A request escalates when it contradicts any stored reference, or when no reference
 * covers it. A neutral reference must not mask a contradiction with another one.
 */
export function contextEscalates(candidate: string, references: readonly string[]): boolean {
  if (references.some(reference => opposed(candidate, reference))) return true;
  return !references.some(reference => !escalates(candidate, reference));
}
