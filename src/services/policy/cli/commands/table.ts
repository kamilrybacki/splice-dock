// Known-command tables: the commands a CLI implements itself, plus its
// built-in aliases. Generic machinery only; per-CLI tables live in ./profiles/.
// Maps (not object literals) keep prototype keys like `constructor` out.

export interface KnownCommandTable {
  readonly top: ReadonlySet<string>;
  /** Canonical parent path joined with ' ' ('' = top level) → alias → canonical name. */
  readonly aliases: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export type CommandAliasSpec = Record<string, Record<string, string>>;

export function knownCommandTable(top: readonly string[], aliases: CommandAliasSpec): KnownCommandTable {
  const aliasMap = new Map<string, ReadonlyMap<string, string>>();
  for (const parent of Object.keys(aliases)) {
    aliasMap.set(parent, new Map(Object.entries(aliases[parent]!)));
  }
  for (const canonical of aliasMap.get('')?.values() ?? []) {
    if (!top.includes(canonical)) {
      throw new Error(`known-commands: alias target ${canonical} is not a top-level command`);
    }
  }
  return { top: new Set(top), aliases: aliasMap };
}

/** Map every alias in `path` to its canonical name, walking from the top so
 *  each token is resolved under its canonical parent. Returns null when the
 *  first token is not a command the binary implements. Returns a new array. */
export function canonicalizeCommandPath(path: readonly string[], table: KnownCommandTable): string[] | null {
  const out: string[] = [];
  for (const tok of path) {
    const canonical = table.aliases.get(out.join(' '))?.get(tok) ?? tok;
    if (out.length === 0 && !table.top.has(canonical)) return null;
    out.push(canonical);
  }
  return out;
}

/** Like canonicalizeCommandPath but keeps an unknown first token as-is. Used
 *  for config rules, where an unknown entry is harmless (it can never match). */
export function canonicalizeRulePath(path: readonly string[], table: KnownCommandTable): string[] {
  return canonicalizeCommandPath(path, table) ?? [...path];
}
