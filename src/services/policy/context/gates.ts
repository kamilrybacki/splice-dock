/**
 * Clause-level vetoes. Word overlap cannot see that "after the dependency was restored"
 * and "before it is restored" state opposite conditions, so opposed markers veto a match.
 */
const OPPOSED: readonly (readonly [RegExp, RegExp])[] = [
  [/\b(?:before|until|prior to|ahead of)\b/, /\b(?:after|once|following)\b/],
  [/\b(?:same|identical)\b/, /\b(?:different|distinct|unrelated|separate)\b/],
  [/\b(?:old|older|previous|outdated|stale)\b/, /\b(?:patched|updated|newer|latest|fixed)\b/],
];

/** True when one text states a condition and the other only its opposite. */
export function opposed(a: string, b: string): boolean {
  const la = a.toLowerCase(), lb = b.toLowerCase();
  return OPPOSED.some(([x, y]) => {
    const ax = x.test(la), ay = y.test(la), bx = x.test(lb), by = y.test(lb);
    return (ax && !ay && by && !bx) || (ay && !ax && bx && !by);
  });
}
