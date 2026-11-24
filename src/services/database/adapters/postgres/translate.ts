// SQLite-flavoured SQL -> Postgres. Only the dialect differences this code
// base actually uses are handled; anything else is passed through. Statements
// that cannot be translated safely (INSERT OR REPLACE) throw so a missed call
// site fails loudly in tests instead of silently misbehaving.

export interface Translated {
  text: string;
  /** Positional params for `$n`, built from the caller's args. */
  values: unknown[];
}

function scan(sql: string, onToken: (ch: string, i: number) => string | null): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? sql.length : j;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    const rep = onToken(ch, i);
    if (rep !== null) {
      out += rep;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Translate `sql` and bind `args` (positional values, or one named object). */
export function translate(sql: string, args: unknown[]): Translated {
  if (/\bINSERT\s+OR\s+REPLACE\b/i.test(sql)) {
    throw new Error('INSERT OR REPLACE is not portable; use ON CONFLICT ... DO UPDATE');
  }
  let text = sql;
  let ignore = false;
  text = text.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, () => { ignore = true; return 'INSERT INTO'; });

  const values: unknown[] = [];
  const named = args.length === 1 && args[0] !== null && typeof args[0] === 'object'
    && !Buffer.isBuffer(args[0]) && !(args[0] instanceof Uint8Array) && !Array.isArray(args[0])
    ? (args[0] as Record<string, unknown>) : null;
  const nameIdx = new Map<string, number>();
  let pos = 0;

  const withParams = scanParams(text, () => {
    if (named) return null;
    values.push(norm(args[pos++]));
    return `$${values.length}`;
  }, (name) => {
    if (!named) throw new Error(`named parameter @${name} without an object argument`);
    let idx = nameIdx.get(name);
    if (idx === undefined) {
      if (!(name in named)) throw new Error(`missing named parameter @${name}`);
      values.push(norm(named[name]));
      idx = values.length;
      nameIdx.set(name, idx);
    }
    return `$${idx}`;
  });

  let out = withParams;
  if (ignore) out = out.replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  if (!named && pos !== args.length) {
    throw new Error(`parameter count mismatch: ${pos} placeholders, ${args.length} values`);
  }
  return { text: out, values };
}

function scanParams(
  sql: string,
  positional: () => string | null,
  byName: (name: string) => string,
): string {
  let skipUntil = -1;
  return scan(sql, (ch, i) => {
    if (i < skipUntil) return '';
    if (ch === '?') return positional();
    if (ch === '@') {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        skipUntil = i + m[0].length;
        return byName(m[1]);
      }
    }
    return null;
  });
}

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
