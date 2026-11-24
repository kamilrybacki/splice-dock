import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cruise } from 'dependency-cruiser';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = resolve('.');
const CORE_FILE = 'src/services/x/core.ts';

describe('ESLint core rules', () => {
  const eslint = new ESLint({ cwd: REPO, overrideConfigFile: join(REPO, 'eslint.config.js') });

  const lint = async (code: string, filePath = CORE_FILE): Promise<string[]> => {
    const [result] = await eslint.lintText(code, { filePath: join(REPO, filePath) });
    return result.messages.map(m => `${m.ruleId}: ${m.message}`);
  };

  const bypasses: Record<string, string> = {
    'destructured env': 'const { env } = process;\nexport const e = env;',
    'globalThis.process.env': 'export const e = globalThis.process.env;',
    'globalThis["process"]': 'export const e = globalThis["process"];',
    'cast to any': 'export const e = (process as unknown as { env: object }).env;',
    'globalThis alias': 'const g = globalThis;\nexport const e = (g as unknown as { process: unknown }).process;',
    'global alias': 'const g = global;\nexport const e = g;',
    'alias': 'const p = process;\nexport const e = p.env;',
    'Reflect.get': "export const e = Reflect.get(process, 'env');",
    'bracket access': "export const e = process['env'];",
    'leading comment, SQL literal': '/* x */ export const q = " FOR UPDATE";',
    'SQL template': 'export const q = `SELECT 1 ${1} SKIP LOCKED`;',
    'pg_advisory': "export const q = 'select pg_advisory_lock(1)';",
    'hashtextextended': "export const q = 'hashtextextended(a, 0)';",
    'isPostgres identifier': 'export const isPostgres = true;',
    'isPostgres property': 'export const f = (d: { isPostgres: boolean }) => d.isPostgres;',
    '.dialect member': 'export const f = (d: { dialect: string }) => d.dialect;',
    "['dialect'] member": "export const f = (d: { dialect: string }) => d['dialect'];",
    'dialect destructuring': 'export const f = ({ dialect }: { dialect: string }) => dialect;',
    'non-literal dynamic import': 'export const f = (m: string) => import(m);',
  };

  for (const [name, code] of Object.entries(bypasses)) {
    it(`reports: ${name}`, async () => {
      expect((await lint(code)).length).toBeGreaterThan(0);
    });
  }

  it('applies to every core layer', async () => {
    for (const path of ['src/common/a.ts', 'src/config/a.ts', 'src/contracts/internal/a.ts', 'src/services/x/deep/a.mts', 'src/services/stray.ts', 'src/unknown/a.ts']) {
      expect((await lint('export const e = process.env;', path)).length).toBeGreaterThan(0);
    }
  });

  it('ignores comments and unrelated code', async () => {
    const code = [
      '// process.env FOR UPDATE isPostgres .dialect',
      '/* SKIP LOCKED pg_advisory */',
      'export const ok = 1;',
      "export const lazy = () => import('./other.js');",
    ].join('\n');
    expect(await lint(code)).toEqual([]);
  });

  it('exempts adapters and root files', async () => {
    const code = 'export const e = process.env;\nexport const q = "FOR UPDATE";';
    expect(await lint(code, 'src/services/x/adapters/pg.ts')).toEqual([]);
    expect(await lint(code, 'src/main.ts')).toEqual([]);
  });
});

describe('dependency-cruiser layer rules', () => {
  let dir: string;

  const write = (path: string, body: string): void => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  // Rule names reported for the whole fixture tree, keyed by importing file.
  const violations = async (): Promise<Map<string, string[]>> => {
    const config = await import(join(REPO, '.dependency-cruiser.cjs'));
    const result = await cruise(['src'], {
      ...config.default.options,
      ruleSet: { forbidden: config.default.forbidden },
      baseDir: dir,
      validate: true,
      tsConfig: { fileName: join(dir, 'tsconfig.json') },
      tsPreCompilationDeps: true,
    });
    const out = new Map<string, string[]>();
    const summary = (result.output as { summary: { violations: { from: string; rule: { name: string } }[] } }).summary;
    for (const v of summary.violations) out.set(v.from, [...(out.get(v.from) ?? []), v.rule.name]);
    return out;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'arch-'));
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
    copyFileSync(join(REPO, 'tsconfig.json'), join(dir, 'tsconfig.json'));
    write('src/common/util.ts', 'export const u = 1;');
    write('src/services/x/adapters/db.ts', "import { readFileSync } from 'node:fs';\nimport pg from 'pg';\nexport const a = [readFileSync, pg];");
    write('src/services/x/ok.ts', "import { z } from 'zod';\nimport { join } from 'node:path';\nimport { u } from '../../common/util.js';\nexport const ok = [z, join, u];");
    write('src/services/x/bad-adapter.ts', "import { a } from './adapters/db.js';\nexport const b = a;");
    write('src/services/x/bad-fs.ts', "import { readFileSync } from 'node:fs';\nexport const b = readFileSync;");
    write('src/services/x/bad-fs-bare.ts', "import { readFileSync } from 'fs';\nexport const b = readFileSync;");
    write('src/services/x/bad-pkg.ts', "import pg from 'pg';\nexport const b = pg;");
    write('src/services/x/bad-type.ts', "import type { Pool } from 'pg';\nexport type B = Pool;");
    write('src/services/x/bad-dynamic.ts', "export const b = () => import('better-sqlite3');");
    write('src/services/x/bad-root.ts', "import { r } from '../../root.js';\nexport const b = r;");
    write('src/services/x/bad-cts.cts', "import { readFileSync } from 'node:fs';\nexport const b = readFileSync;");
    write('src/root.ts', 'export const r = 1;');
    write('src/common/bad-up.ts', "import { ok } from '../services/x/ok.js';\nexport const b = ok;");
    write('src/contracts/internal/bad-pkg.ts', "import { z } from 'zod';\nexport const b = z;");
    write('src/services/stray.ts', "import { readFileSync } from 'node:fs';\nexport const b = readFileSync;");
    write('src/contracts/other/stray.ts', "import { u } from '../../common/util.js';\nexport const b = u;");
    write('src/config/ok.ts', "import { z } from 'zod';\nimport { ok } from '../services/x/ok.js';\nexport const c = [z, ok];");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reports forbidden imports and nothing else', async () => {
    const found = await violations();
    const flagged = [...found.keys()].sort();
    expect(flagged).toEqual([
      'src/common/bad-up.ts',
      'src/contracts/internal/bad-pkg.ts',
      'src/contracts/other/stray.ts',
      'src/services/x/bad-adapter.ts',
      'src/services/x/bad-cts.cts',
      'src/services/x/bad-dynamic.ts',
      'src/services/x/bad-fs-bare.ts',
      'src/services/x/bad-fs.ts',
      'src/services/x/bad-pkg.ts',
      'src/services/x/bad-root.ts',
      'src/services/x/bad-type.ts',
      'src/services/stray.ts',
    ].sort());
    expect(found.get('src/services/stray.ts')).toContain('unknown-layer');
    expect(found.get('src/contracts/other/stray.ts')).toContain('unknown-layer');
    expect(found.get('src/services/x/bad-adapter.ts')).toContain('core-local-imports');
  });
});
