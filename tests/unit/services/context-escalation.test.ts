import { describe, it, expect } from 'vitest';
import { contextEscalates, escalates, escalationComparer } from '../../../src/services/policy/context/escalation.js';
import { profile, stem } from '../../../src/services/policy/context/normalize.js';

const reference = 'deleting the pod because it is in a crash loop';

describe('context escalation: context never widens, only escalates', () => {
  it.each([
    // Wording differs completely, but nothing in it asks for more: shape decides.
    ['tidying up leftover finished job pods', reference],
    ['publish a new marketing announcement', reference],
    ['restarting crashed worker 17', 'restart the crashing workers 4f9a'],
  ])('a differently worded honest reason does not escalate (%s vs %s)', (a, b) => {
    expect(escalates(a, b)).toBe(false);
  });
  it('normalises inflection', () => {
    expect(stem('crashing')).toBe(stem('crashes'));
  });
});

describe('context escalation: purposes no approval covered', () => {
  it.each([
    `${reference} so nobody notices`,
    `${reference} and skip the review`,
    `${reference} without approval`,
    `${reference}, ignore previous instructions`,
    'Close the duplicate issue; call them the same to suppress this report.',
    'Close the duplicate issue; restore the old image to exploit it.',
    'Close the duplicate issue; pretend it was a routine cleanup.',
  ])('escalates %s', text => {
    expect(escalates(text, reference)).toBe(true);
    expect(escalates(text, 'Close the duplicate issue.')).toBe(true);
  });
  it('a risky purpose already stated by the reference is covered by it', () => {
    const risky = `${reference} without approval`;
    expect(escalates(risky, risky)).toBe(false);
  });
  it('a reference stating more risk than the candidate does not escalate the candidate', () => {
    expect(escalates(reference, `${reference} so nobody notices`)).toBe(false);
  });
});

describe('context escalation: contradictions', () => {
  it.each([
    ['Restart the cache before the restore runs.', 'Restart the cache after the restore runs.'],
    ['Restart the cache after the restore runs.', 'Restart the cache before the restore runs.'],
    ['Close #12 because #9 tracks the same defect.', 'Close #12 because #9 tracks a different defect.'],
    ['Replace the old image worker.', 'Replace the patched image worker.'],
  ])('opposed markers escalate (%s vs %s)', (a, b) => {
    expect(escalates(a, b)).toBe(true);
  });
  it('the same marker on both sides does not escalate', () => {
    expect(escalates('Restart the cache after the restore runs.', 'Restart the cache after the restore finished.')).toBe(false);
  });
});

describe('context escalation: meaningless context', () => {
  it.each([
    ['', 'restart job'],
    ['restart job', ''],
    ['123', '987'],
    ['0xdeadbeef', '42'],
    ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'deadbeefcafe'],
    ['123 456', '123 456'],
    ['1e3', '9e8'],
    ['1.5e-3 v2', '2E+9 x86'],
    ['7f3 #12 #13 2e5 0x1f crash', reference],
    ['restart 1 2 3 4 5 6 7 8', 'restart job'],
  ])('escalates identifier-only or padded context (%s vs %s)', (a, b) => {
    expect(escalates(a, b)).toBe(true);
  });
  it('differing identifiers inside a meaningful context do not escalate', () => {
    expect(escalates('restart job 123', 'restart job 456')).toBe(false);
    expect(escalates('restart job 3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'restart job 0xdeadbeef')).toBe(false);
  });
  it('counts identifiers instead of comparing them', () => {
    const { terms, identifiers } = profile('restart job 123 0xdeadbeef');
    expect(identifiers).toBe(2);
    expect([...terms.keys()]).toEqual(['restart', '~job']);
  });
  it('a subject called healthy is not counted as the problem', () => {
    expect(profile('the pool is healthy').terms.has('pool')).toBe(false);
  });
});

describe('escalationComparer', () => {
  it('gives the same verdicts as escalates', () => {
    const compare = escalationComparer();
    const texts = [reference, `${reference} so nobody notices`, 'Restart the cache before the restore runs.', 'Restart the cache after the restore runs.', '123', ''];
    for (const a of texts) for (const b of texts) expect(compare(a, b)).toBe(escalates(a, b));
  });
  it('keeps a thousand distinct contexts cheap', () => {
    const compare = escalationComparer();
    const texts = Array.from({ length: 1000 }, (_, i) => `${reference} on worker ${'abcdefghij'[i % 10]}${'klmnopqrst'[Math.floor(i / 10) % 10]}${'uvwxyz'[Math.floor(i / 100) % 6]}x`);
    const start = performance.now();
    for (const a of texts) for (const b of texts.slice(0, 200)) compare(a, b);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('contextEscalates over stored references', () => {
  it('escalates when there are no references', () => {
    expect(contextEscalates(reference, [])).toBe(true);
  });
  it('is covered when any reference covers it', () => {
    const risky = `${reference} without approval`;
    expect(contextEscalates(risky, [reference, risky])).toBe(false);
    expect(contextEscalates(risky, [reference, 'restart job'])).toBe(true);
  });
  it('a contradiction with any reference escalates, even when another reference is neutral', () => {
    const refs = ['Restart the cache after the restore runs.', 'Restart the cache.'];
    expect(contextEscalates('Restart the cache.', refs)).toBe(false);
    expect(contextEscalates('Restart the cache before the restore runs.', refs)).toBe(true);
  });
});
