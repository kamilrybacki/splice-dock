import { LEGACY_ADMIN_IDENTITY } from '../../../src/services/admin/base.js';
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNamedAdminTokens } from '../../../src/services/admin/adapters/fastify/tokens.js';
import { splicedockConfigSchema } from '../../../src/config/schema.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env['T4_TEST_ALICE'];
  delete process.env['T4_TEST_BOB'];
});

function tmpFile(content: string): string {
  const d = mkdtempSync(join(tmpdir(), 't4-'));
  dirs.push(d);
  const p = join(d, 'tok');
  writeFileSync(p, content);
  return p;
}

describe('resolveNamedAdminTokens', () => {
  it('reads tokens from env and from file (trimming a trailing newline)', () => {
    process.env['T4_TEST_ALICE'] = 'alice-placeholder-token';
    const file = tmpFile('bob-placeholder-token\n');
    const out = resolveNamedAdminTokens([
      { name: 'alice', token_env: 'T4_TEST_ALICE' },
      { name: 'bob', token_file: file },
    ]);
    expect(out).toEqual([
      { name: 'alice', token: 'alice-placeholder-token' },
      { name: 'bob', token: 'bob-placeholder-token' },
    ]);
  });

  it('throws when the env var is unset or empty, naming the variable but not a value', () => {
    expect(() => resolveNamedAdminTokens([{ name: 'alice', token_env: 'T4_TEST_ALICE' }])).toThrow(/T4_TEST_ALICE/);
    process.env['T4_TEST_ALICE'] = '';
    expect(() => resolveNamedAdminTokens([{ name: 'alice', token_env: 'T4_TEST_ALICE' }])).toThrow(/alice/);
  });

  it('throws when the file is missing or empty', () => {
    expect(() => resolveNamedAdminTokens([{ name: 'a', token_file: '/nonexistent/t4-missing' }])).toThrow(/a/);
    expect(() => resolveNamedAdminTokens([{ name: 'a', token_file: tmpFile('  \n') }])).toThrow(/empty/);
  });

  it('rejects two names sharing one token, and the reserved legacy name', () => {
    process.env['T4_TEST_ALICE'] = 'same';
    process.env['T4_TEST_BOB'] = 'same';
    expect(() => resolveNamedAdminTokens([
      { name: 'alice', token_env: 'T4_TEST_ALICE' },
      { name: 'bob', token_env: 'T4_TEST_BOB' },
    ])).toThrow(/same token/);
    expect(() => resolveNamedAdminTokens([{ name: LEGACY_ADMIN_IDENTITY, token_env: 'T4_TEST_ALICE' }])).toThrow(/reserved/);
  });
});

describe('server.admin_tokens schema', () => {
  const parse = (admin_tokens: unknown) => splicedockConfigSchema.safeParse({ server: { admin_tokens } });

  it('defaults to an empty list', () => {
    const r = splicedockConfigSchema.parse({});
    expect(r.server.admin_tokens).toEqual([]);
  });

  it('accepts exactly one of token_env / token_file', () => {
    expect(parse([{ name: 'alice', token_env: 'X' }]).success).toBe(true);
    expect(parse([{ name: 'alice', token_file: '/run/x' }]).success).toBe(true);
    expect(parse([{ name: 'alice' }]).success).toBe(false);
    expect(parse([{ name: 'alice', token_env: 'X', token_file: '/run/x' }]).success).toBe(false);
  });

  it('rejects bad or duplicate names', () => {
    expect(parse([{ name: 'has space', token_env: 'X' }]).success).toBe(false);
    expect(parse([{ name: '', token_env: 'X' }]).success).toBe(false);
    expect(parse([{ name: 'a', token_env: 'X' }, { name: 'a', token_env: 'Y' }]).success).toBe(false);
  });
});
