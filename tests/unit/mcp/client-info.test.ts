import { describe, it, expect } from 'vitest';
import { clientLogFields, sanitizeClientField } from '../../../src/services/mcp/adapters/express/client-info.js';

describe('sanitizeClientField', () => {
  it('accepts plain strings', () => expect(sanitizeClientField('claude-code')).toBe('claude-code'));
  it('rejects non-strings and empty results', () => {
    for (const v of [undefined, null, 5, {}, ['a'], '', '\n\t\u0000']) expect(sanitizeClientField(v)).toBeUndefined();
  });
  it('strips control characters (log injection)', () => {
    expect(sanitizeClientField('a\nb\r\u0000c\u001b[31md')).toBe('abc[31md');
  });
  it('strips invisible format characters', () => {
    expect(sanitizeClientField('a\u2028b\u202ec\u200bd')).toBe('abcd');
  });
  it('truncates to 64 characters', () => expect(sanitizeClientField('x'.repeat(200))).toHaveLength(64));
});

describe('clientLogFields', () => {
  it('maps name/version to client/client_version', () => {
    expect(clientLogFields({ name: 'codex', version: '1.2.3' })).toEqual({ client: 'codex', client_version: '1.2.3' });
  });
  it('omits absent or invalid fields', () => {
    expect(clientLogFields(undefined)).toEqual({});
    expect(clientLogFields({ name: 'codex' } as never)).toEqual({ client: 'codex' });
    expect(clientLogFields({ name: 7, version: '\n' } as never)).toEqual({});
  });
  it('falls back to the User-Agent header when clientInfo is missing', () => {
    expect(clientLogFields(undefined, 'claude-code/2.1.0')).toEqual({ client: 'claude-code/2.1.0' });
    expect(clientLogFields({ version: '9' } as never, 'ua\nx')).toEqual({ client: 'uax', client_version: '9' });
  });
  it('prefers clientInfo over the User-Agent header', () => {
    expect(clientLogFields({ name: 'codex' } as never, 'node')).toEqual({ client: 'codex' });
  });
  it('ignores an empty or non-string User-Agent', () => {
    expect(clientLogFields(undefined, '')).toEqual({});
    expect(clientLogFields(undefined, ['a'])).toEqual({});
  });
});
