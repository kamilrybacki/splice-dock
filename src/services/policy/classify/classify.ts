import { worse, type Classification, type OpClass, type ToolTable, type VerbEntry } from './base.js';
import { TABLES } from './tables.js';

function unknown(key: string, reason: string): Classification {
  return { class: 'unknown', key, reason };
}

/** Longest verb entry matching the leading positionals, so `rollout restart` beats `rollout`. */
function matchVerb(table: ToolTable, positional: readonly string[]): { entry: VerbEntry; used: number } | null {
  let best: { entry: VerbEntry; used: number } | null = null;
  for (const entry of table.verbs) {
    const words = entry.verb.split(' ');
    if (words.every((w, i) => positional[i] === w) && (!best || words.length > best.used)) {
      best = { entry, used: words.length };
    }
  }
  return best;
}

/**
 * Classify one operation from its tool and argv.
 *
 * The result is `unknown` whenever the tool, the verb, the resource kind or any flag is not in the
 * closed table, so only operations a human has already written down are ever classed. Flags and the
 * object kind can only raise the class of a verb, never lower it, except the explicit per-kind
 * overrides of the table (for example `kubectl delete pod` is disruptive, `delete secret` is not).
 */
export function classifyOperation(
  tool: string,
  argv: readonly string[],
  tables: Readonly<Record<string, ToolTable>> = TABLES,
): Classification {
  const table = Object.hasOwn(tables, tool) ? tables[tool] : undefined;
  const positional: string[] = [];
  let raised = false;
  let key = `${tool}|?`;
  if (!table) return unknown(key, 'tool not in table');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) { positional.push(arg.toLowerCase()); continue; }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const raiseValues = table.raiseValueFlags?.[flag];
    if (raiseValues) {
      const value = (inline ?? argv[++i] ?? '').toUpperCase();
      if (raiseValues.includes('*') || raiseValues.includes(value)) raised = true;
      continue;
    }
    if (table.raiseFlags.includes(flag)) { raised = true; continue; }
    if (Object.hasOwn(table.neutralFlags, flag)) {
      if (table.neutralFlags[flag] && inline === undefined) i++;
      continue;
    }
    return unknown(key, `flag ${flag} not in table`);
  }
  const match = matchVerb(table, positional);
  if (!match) return unknown(`${tool}|${positional.slice(0, 2).join(' ') || '?'}`, 'verb not in table');
  const kind = positional[match.used]?.split('/')[0];
  key = `${tool}|${match.entry.verb}${kind ? `|${kind}` : ''}`;
  let cls: OpClass = match.entry.class;
  const kinds = match.entry.kinds;
  if (kinds) {
    if (kind && Object.hasOwn(kinds, kind)) cls = kinds[kind]!;
    else if (match.entry.closedKinds) return unknown(key, `kind ${kind ?? '(none)'} not in table`);
  }
  if (raised) cls = worse(cls, 'destructive');
  return { class: cls, key, reason: raised ? 'raised by flag' : 'table' };
}
