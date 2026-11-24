// Verifies the built-in gh tables (known commands, aliases, flag arity)
// against the help of the exact gh release they were taken from. Runs
// wherever gh PINNED_GH_VERSION is on PATH (the image, CI with that gh);
// fails in CI or skips locally with the reason otherwise. Only offline help is read, under a fresh
// GH_CONFIG_DIR so user aliases and extensions cannot leak into the result.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flagTableFor, invocationFlagTable, type FlagArity } from '../../../src/services/policy/cli/flags/arity.js';
import { knownCommandsFor } from '../../../src/services/policy/cli/commands/known.js';
import { PINNED_GH_VERSION } from '../../../src/services/policy/cli/gh/version.js';

const configDir = mkdtempSync(join(tmpdir(), 'splicedock-gh-help-'));
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

// No tokens or host settings from the caller's environment reach gh.
const env = {
  PATH: process.env.PATH ?? '',
  HOME: configDir,
  GH_CONFIG_DIR: configDir,
  XDG_CONFIG_HOME: configDir,
  XDG_DATA_HOME: configDir,
  XDG_STATE_HOME: configDir,
  XDG_CACHE_HOME: configDir,
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PROMPT_DISABLED: '1',
  GH_TELEMETRY: 'false',
  NO_COLOR: '1',
};

function gh(...args: string[]): { status: number | null; out: string; error?: Error } {
  const r = spawnSync('gh', args, { env, encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error };
}

function skipReason(): string | null {
  const r = gh('--version');
  if (r.error || r.status !== 0) return `gh is not on PATH (${r.error?.message ?? `exit ${r.status}`})`;
  const found = /^gh version (\S+) /m.exec(r.out)?.[1] ?? 'unknown';
  return found === PINNED_GH_VERSION ? null : `found gh ${found}, the tables are pinned to gh ${PINNED_GH_VERSION}`;
}

const reason = skipReason();
if (reason && process.env.CI) throw new Error(`[gh-help-tables] required in CI: ${reason}`);
// eslint-disable-next-line no-console -- the skip reason must be visible in CI output
if (reason) console.warn(`[gh-help-tables] skipped: ${reason}`);

interface Flag { long: string; short?: string; arity: FlagArity }
interface Section { path: string; flags: Flag[]; aliases: string[]; configAlias: boolean }

const HEADING = /^#{2,4} gh (.*)$/;
const FLAG = /^\s+(?:-([A-Za-z0-9]), )?--([\w-]+)(?: (\S+))?(?:\s{2,}|$)/;
const WORD = /^[a-z0-9][a-z0-9-]*$/;

function parseReference(text: string): Map<string, Section> {
  const sections = new Map<string, Section>();
  let current: Section | undefined;
  let awaitingAliases = false;
  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading) {
      const words: string[] = [];
      for (const w of heading[1]!.split(' ')) { if (!WORD.test(w)) break; words.push(w); }
      current = { path: words.join(' '), flags: [], aliases: [], configAlias: false };
      sections.set(current.path, current);
      awaitingAliases = false;
      continue;
    }
    if (!current) continue;
    if (line === 'Aliases') { awaitingAliases = true; continue; }
    // Default config aliases (`gh co`) are listed as `Alias for "pr checkout"`.
    if (/^Alias for "/.test(line)) { current.configAlias = true; continue; }
    if (awaitingAliases && line.trim()) {
      current.aliases.push(...line.split(',').map(a => a.trim()));
      awaitingAliases = false;
      continue;
    }
    const flag = FLAG.exec(line);
    if (flag) current.flags.push({ short: flag[1], long: flag[2]!, arity: flag[3] ? 'value' : 'bool' });
  }
  return sections;
}

/** `gh --help` lists help topics as `  name:  description` under HELP TOPICS. */
function parseHelpTopics(rootHelp: string): string[] {
  const block = /^HELP TOPICS\n([\s\S]*?)\n\n/m.exec(rootHelp)?.[1] ?? '';
  return block.split('\n').map(l => /^\s+([a-z-]+):/.exec(l)?.[1]).filter((t): t is string => !!t);
}

/** Flags visible at `path`: its own plus every ancestor's (persistent) flags. */
function effectiveFlags(sections: Map<string, Section>, path: string): Flag[] {
  const words = path.split(' ');
  return words.flatMap((_, i) => sections.get(words.slice(0, i + 1).join(' '))?.flags ?? []);
}

function aritiesBy(flags: Flag[], key: 'long' | 'short'): Map<string, Set<FlagArity>> {
  const seen = new Map<string, Set<FlagArity>>();
  for (const f of flags) {
    const name = f[key];
    if (name === undefined) continue;
    seen.set(name, (seen.get(name) ?? new Set()).add(f.arity));
  }
  return seen;
}

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

describe.skipIf(reason !== null)(
  `gh tables match gh ${PINNED_GH_VERSION} help${reason ? ` (skipped: ${reason})` : ''}`,
  () => {
    const sections = reason ? new Map<string, Section>() : parseReference(gh('help', 'reference').out);
    const topics = reason ? [] : parseHelpTopics(gh('--help').out);
    const known = knownCommandsFor('gh')!;
    const allFlags = [...sections.values()].flatMap(s => s.flags);

    it('parsed the reference and the help topics', () => {
      expect(sections.size).toBeGreaterThan(100);
      expect(topics).toContain('reference');
    });

    it('top-level commands and help topics match in both directions', () => {
      // Config aliases such as `co` expand to another command before gh parses
      // it; they are not commands the policy should know.
      const commands = [...sections.values()].filter(s => s.path && !s.path.includes(' ') && !s.configAlias).map(s => s.path);
      // help and version are built into cobra/gh and have no reference section.
      expect(sorted(known.top)).toEqual(sorted(new Set([...commands, ...topics, 'help', 'version'])));
    });

    it.each(['help', 'version'])('the built-in %s command exists', cmd => {
      const r = gh(cmd);
      expect(r.status).toBe(0);
      expect(r.out).not.toMatch(/unknown command/i);
    });

    it('every help topic resolves', () => {
      for (const topic of topics) {
        const r = gh('help', topic);
        expect({ topic, status: r.status, unknown: r.out.includes('Unknown help topic') })
          .toEqual({ topic, status: 0, unknown: false });
      }
    });

    it('command aliases match the reference in both directions', () => {
      const expected: Record<string, Record<string, string>> = {};
      for (const s of sections.values()) {
        const words = s.path.split(' ');
        const parent = words.slice(0, -1).join(' ');
        // Sub-command aliases may be printed under the parent's alias
        // (`gh cs ls`), so only the last word names the alias.
        for (const alias of s.aliases) (expected[parent] ??= {})[alias.split(' ').at(-1)!] = words.at(-1)!;
      }
      const actual: Record<string, Record<string, string>> = {};
      for (const [parent, map] of known.aliases) actual[parent] = Object.fromEntries(map);
      expect(actual).toEqual(expected);
    });

    it('every global long flag exists with the same arity in every command', () => {
      const seen = aritiesBy(allFlags, 'long');
      const drift = [...flagTableFor('gh').long]
        .map(([name, arity]) => ({ flag: `--${name}`, table: arity, help: sorted(seen.get(name) ?? []) }))
        .filter(d => d.help.join() !== d.table);
      expect(drift).toEqual([]);
    });

    it('every global short flag exists with the same arity in every command', () => {
      const seen = aritiesBy(allFlags, 'short');
      const drift = [...flagTableFor('gh').short]
        .map(([name, arity]) => ({ flag: `-${name}`, table: arity, help: sorted(seen.get(name) ?? []) }))
        .filter(d => d.help.join() !== d.table);
      expect(drift).toEqual([]);
    });

    it.each(['short', 'long'] as const)("per-command %s flags never contradict that command's help", key => {
      const base = flagTableFor('gh');
      const dash = key === 'short' ? '-' : '--';
      let checked = 0;
      const drift: { path: string; flag: string; table: FlagArity; help: string[] }[] = [];
      for (const path of [...sections.keys()].filter(p => p.split(' ').length >= 2)) {
        const entries = invocationFlagTable('gh', path.split(' '), base)[key];
        const visible = aritiesBy(effectiveFlags(sections, path), key);
        for (const [name, arity] of entries) {
          if (base[key].get(name) === arity) continue; // global entry, verified above
          const help = sorted(visible.get(name) ?? []);
          // A long override on a command without that flag is inert: gh
          // rejects the unknown flag. A short override must exist.
          if (key === 'long' && help.length === 0) continue;
          checked++;
          if (help.join() !== arity) drift.push({ path, flag: `${dash}${name}`, table: arity, help });
        }
      }
      expect(checked).toBeGreaterThan(0);
      expect(drift).toEqual([]);
    });
  },
);
