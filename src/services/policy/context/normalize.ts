import { COPULAS, FINE_WORDS, NEGATORS, OPERATION_WORDS, PHRASES, REASONS, RISK_WORDS, STOP_WORDS, TOPICS } from './lexicon.js';

/** How much one term says about the reason for an operation. */
export const WEIGHT = { reason: 3, topic: 1, plain: 0.5, operation: 0.2 } as const;
export const RISK_PREFIX = 'risk:';
const NEGATED = '!';
export const REASON_PREFIX = '#';

const words = (list: string): string[] => list.split(/\s+/).filter(Boolean);
const VOWEL = /[aeiouy]/;
const SUFFIXES: readonly (readonly [string, number])[] = [['ing', 3], ['ed', 3], ['ly', 3], ['ion', 4], ['ment', 4], ['al', 4]];

function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (/(?:[sxz]|ch|sh)es$/.test(word)) return word.slice(0, -2);
  return word.endsWith('s') ? word.slice(0, -1) : word;
}
function unsuffixed(word: string): string {
  for (const [suffix, min] of SUFFIXES) {
    const base = word.slice(0, -suffix.length);
    if (word.endsWith(suffix) && base.length >= min && VOWEL.test(base)) return base;
  }
  return word;
}
/** Light suffix stripper: conflates inflections, makes no attempt at real lemmas. */
export function stem(word: string): string {
  if (word.length < 4) return word;
  let base = unsuffixed(unsuffixed(singular(word)));
  if (base.length > 3 && base.at(-1) === base.at(-2) && !VOWEL.test(base.at(-1)!)) base = base.slice(0, -1);
  if (base.length > 3 && base.endsWith('e')) base = base.slice(0, -1);
  return base.length > 3 && base.endsWith('y') ? `${base.slice(0, -1)}i` : base;
}

const STOP = new Set(words(STOP_WORDS));
const NEGATOR = new Set(words(NEGATORS));
const FINE = new Set(words(FINE_WORDS));
const COPULA = new Set(words(COPULAS));
function buildIndex(): ReadonlyMap<string, readonly [string, number]> {
  const index = new Map<string, readonly [string, number]>();
  for (const word of words(OPERATION_WORDS)) index.set(stem(word), [stem(word), WEIGHT.operation]);
  for (const [topic, list] of Object.entries(TOPICS)) for (const word of words(list)) index.set(stem(word), [`~${topic}`, WEIGHT.topic]);
  for (const [reason, list] of Object.entries(REASONS)) for (const word of words(list)) index.set(stem(word), [`${REASON_PREFIX}${reason}`, WEIGHT.reason]);
  for (const word of words(RISK_WORDS)) index.set(stem(word), [`${RISK_PREFIX}${stem(word)}`, WEIGHT.reason]);
  for (const [, token] of PHRASES) if (token.trim().startsWith('risk')) index.set(stem(token.trim()), [`${RISK_PREFIX}${token.trim()}`, WEIGHT.reason]);
  return index;
}
const INDEX = buildIndex();

/** Lower-cases, expands contractions, marks identifiers and folds known phrases into one token. */
function canonical(text: string): string {
  const plain = text.toLowerCase().replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, ' 0 ').replace(/\b[0-9a-f]{8,}\b/g, ' 0 ')
    .replace(/\bwon['’]t\b/g, 'will not').replace(/\bcan['’]t\b/g, 'can not').replace(/n['’]t\b/g, ' not').replace(/['’]s\b/g, '');
  return PHRASES.reduce((out, [pattern, token]) => out.replace(pattern, token), plain);
}

export interface Profile {
  /** Weighted terms: reason concepts, topics, plain words and operation words. */
  readonly terms: ReadonlyMap<string, number>;
  /** Tokens dropped as identifiers (numbers, hashes, versions). */
  readonly identifiers: number;
}
/** How many function words a negator may reach across: "not being evicted", but not "can not keep up with the burst". */
const NEGATION_REACH = 2;

/** "the pool is healthy" says the pool is not the problem: the clause so far counts as negated. */
function negate(terms: Map<string, number>, [term, weight]: readonly [string, number]): void {
  if (term.startsWith(NEGATED) || term.startsWith(RISK_PREFIX)) return;
  terms.delete(term);
  terms.set(NEGATED + term, weight);
}

/** Reads a justification into weighted terms. Identifiers are counted, never compared. */
export function profile(text: string): Profile {
  const terms = new Map<string, number>();
  let identifiers = 0, reach = -1, previous = '', clause: (readonly [string, number])[] = [];
  for (const token of canonical(text).match(/[a-z0-9]+|[,.;:!?]/g) ?? []) {
    const after = previous;
    previous = token;
    if (/\d/.test(token)) { identifiers++; continue; }
    if (!/[a-z]/.test(token)) { reach = -1; clause = []; continue; }
    if (FINE.has(token) && COPULA.has(after)) { for (const term of clause) negate(terms, term); clause = []; continue; }
    if (NEGATOR.has(token)) { reach = NEGATION_REACH; continue; }
    if (STOP.has(token)) { reach--; continue; }
    const base = stem(token);
    const [term, weight] = INDEX.get(base) ?? [base, WEIGHT.plain];
    const stored = reach >= 0 && !term.startsWith(RISK_PREFIX) ? NEGATED + term : term;
    terms.set(stored, weight);
    clause = [...clause, [stored, weight]];
    reach = -1;
  }
  return { terms, identifiers };
}
