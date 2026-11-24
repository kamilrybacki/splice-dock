import { describe, it, expect } from 'vitest';
import { resolveDbTarget } from '../../../src/services/database/adapters/target.js';
import { translate } from '../../../src/services/database/adapters/postgres/translate.js';

describe('pg translate', () => {
  it('converts ? to $n in order', () => {
    const t = translate('SELECT * FROM t WHERE a = ? AND b = ?', [1, 'x']);
    expect(t.text).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(t.values).toEqual([1, 'x']);
  });

  it('leaves ? inside string literals and comments alone', () => {
    const t = translate("SELECT '?' AS q, \"a?b\" FROM t -- why?\nWHERE a = ?", [5]);
    expect(t.text).toContain("'?'");
    expect(t.text).toContain('"a?b"');
    expect(t.text).toContain('-- why?');
    expect(t.text.endsWith('a = $1')).toBe(true);
    expect(t.values).toEqual([5]);
  });

  it('maps named params and reuses indexes', () => {
    const t = translate('UPDATE t SET a=@a, b=@b WHERE a=@a', [{ a: 1, b: 2 }]);
    expect(t.text).toBe('UPDATE t SET a=$1, b=$2 WHERE a=$1');
    expect(t.values).toEqual([1, 2]);
  });

  it('throws on missing named param', () => {
    expect(() => translate('SELECT @x', [{ y: 1 }])).toThrow(/missing named parameter @x/);
  });

  it('rewrites INSERT OR IGNORE', () => {
    const t = translate('INSERT OR IGNORE INTO t (a) VALUES (?);', [1]);
    expect(t.text).toBe('INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING');
  });

  it('rejects INSERT OR REPLACE', () => {
    expect(() => translate('INSERT OR REPLACE INTO t (a) VALUES (?)', [1])).toThrow(/not portable/);
  });

  it('throws on parameter count mismatch', () => {
    expect(() => translate('SELECT ?', [1, 2])).toThrow(/mismatch/);
  });

  it('normalises undefined and booleans', () => {
    const t = translate('SELECT ?, ?, ?', [undefined, true, false]);
    expect(t.values).toEqual([null, 1, 0]);
  });

  it('keeps Buffers as positional values', () => {
    const b = Buffer.from([1, 2]);
    const t = translate('INSERT INTO t (b) VALUES (?)', [b]);
    expect(t.values[0]).toBe(b);
  });
});

describe('resolveDbTarget', () => {
  it('refuses the SQLite fallback when Postgres is required', () => {
    expect(() => resolveDbTarget({ SPLICEDOCK_REQUIRE_POSTGRES: '1', SPLICEDOCK_DB_PATH: '/x.db' })).toThrow(/SPLICEDOCK_DB_DSN is not set/);
    expect(resolveDbTarget({ SPLICEDOCK_REQUIRE_POSTGRES: '1', SPLICEDOCK_DB_DSN: 'postgres://h/db' })).toBe('postgres://h/db');
    expect(resolveDbTarget({ SPLICEDOCK_REQUIRE_POSTGRES: '0', SPLICEDOCK_DB_PATH: '/x.db' })).toBe('/x.db');
  });

  it('prefers a postgres DSN, falls back to path then default', () => {
    expect(resolveDbTarget({ SPLICEDOCK_DB_DSN: 'postgres://h/db', SPLICEDOCK_DB_PATH: '/x' })).toBe('postgres://h/db');
    expect(resolveDbTarget({ SPLICEDOCK_DB_PATH: '/x.db' })).toBe('/x.db');
    expect(resolveDbTarget({})).toContain('splicedock.db');
  });
  it('rejects a malformed DSN without echoing it', () => {
    const bad = 'pg://user:s3cret@host/db';
    expect(() => resolveDbTarget({ SPLICEDOCK_DB_DSN: bad })).toThrow(/postgres:\/\/ or postgresql:\/\/ URL/);
    try { resolveDbTarget({ SPLICEDOCK_DB_DSN: bad }); } catch (e) { expect(String(e)).not.toContain('s3cret'); }
  });
  it('fails when SPLICEDOCK_DB_DSN is set but empty instead of silently using SQLite', () => {
    expect(() => resolveDbTarget({ SPLICEDOCK_DB_DSN: '', SPLICEDOCK_DB_PATH: '/x.db' })).toThrow(/SPLICEDOCK_DB_DSN is set but empty/);
    expect(() => resolveDbTarget({ SPLICEDOCK_DB_DSN: '   ' })).toThrow(/SPLICEDOCK_DB_DSN is set but empty/);
  });
});
