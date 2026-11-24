import { expect, it } from 'vitest';
import { extractSubcommandPaths, flagTableFor, invocationFlagTable } from '../../../src/services/policy/cli/flag-arity.js';
it('does not globally classify kubectl -f (filename versus logs follow)', () => {
  expect(extractSubcommandPaths(['logs', '-f', 'pod'], flagTableFor('kubectl'))).toEqual(expect.arrayContaining([['logs', 'pod']]));
});
it('does not globally classify gh -a (assignee versus repo sync all)', () => {
  expect(flagTableFor('gh').short.has('a')).toBe(false);
});
it('does not globally classify gh -h (help versus --hostname/--host/--homepage)', () => {
  const base = flagTableFor('gh');
  expect(base.short.has('h')).toBe(false);
  expect(invocationFlagTable('gh', ['auth', 'status'], base).short.get('h')).toBe('value');
  expect(invocationFlagTable('gh', ['repo', 'create'], base).short.get('h')).toBe('value');
});
it('classifies gh --json, --template and --comments per command', () => {
  const base = flagTableFor('gh');
  for (const name of ['json', 'template', 'comments', 'confirm']) expect(base.long.has(name)).toBe(false);
  const long = (...path: string[]) => invocationFlagTable('gh', path, base).long;
  expect(long('workflow', 'run').get('json')).toBe('bool');
  expect(long('pr', 'view').get('json')).toBe('value');
  expect(long('repo', 'edit').get('template')).toBe('bool');
  expect(long('pr', 'create').get('template')).toBe('value');
  expect(long('pr', 'view').get('comments')).toBe('bool');
  expect(long('search', 'prs').get('comments')).toBe('value');
});
it('keeps gh -a/-l to the create commands and drops unverified overrides', () => {
  const base = flagTableFor('gh');
  const short = (...path: string[]) => invocationFlagTable('gh', path, base).short;
  expect(short('pr', 'edit').has('a')).toBe(false);
  expect(short('issue', 'edit').has('l')).toBe(false);
  expect(short('issue', 'create').get('l')).toBe('value');
  expect(short('repo', 'clone').has('q')).toBe(false);
  expect(short('repo', 'sync').has('f')).toBe(false);
});
