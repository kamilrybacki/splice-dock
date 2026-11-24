import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/check-layers.mjs');

interface Run {
  code: number;
  out: string;
}

describe('check-layers', () => {
  let root: string;
  let src: string;
  let baseline: string;

  const file = (path: string, body: string): void => {
    const full = join(src, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  const run = (...extra: string[]): Run => {
    try {
      const out = execFileSync('node', [SCRIPT, src, '--baseline', baseline, ...extra], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (error: unknown) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'layers-'));
    src = join(root, 'src');
    baseline = join(root, 'baseline.json');
    file('main.ts', "import pg from 'pg';\nconsole.log(process.env.X, pg);\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('passes clean code and ignores adapters and the root', () => {
    file('common/id.ts', "import { randomUUID } from 'node:crypto';\nexport const id = randomUUID;\n");
    file('services/x/adapters/db.ts', "import pg from 'pg';\nexport const url = process.env.DB;\n");
    expect(run()).toMatchObject({ code: 0 });
  });

  it('rejects a package that is not on the layer allowlist', () => {
    file('services/x/base.ts', "import pg from 'pg';\nexport default pg;\n");
    file('contracts/outbound/x.ts', "import type { Tool } from '@modelcontextprotocol/sdk/types.js';\nexport type T = Tool;\n");
    const result = run();
    expect(result.code).toBe(1);
    expect(result.out).toContain("services: services/x/base.ts imports package 'pg'");
    expect(result.out).toContain("contracts: contracts/outbound/x.ts imports package '@modelcontextprotocol/sdk'");
  });

  it('rejects process.env in every core file, but not in comments', () => {
    file('services/x/base.ts', "export const on = process['env'].FLAG === '1';\n");
    file('services/y/base.ts', '// reads process.env.FLAG upstream\nexport const y = 1;\n');
    file('config/loader.ts', 'export const kube = process.env.KUBECONFIG;\n');
    file('main.ts', 'export const root = process.env.FLAG;\n');
    const result = run();
    expect(result.code).toBe(1);
    expect(result.out).toContain('services: services/x/base.ts reads process.env');
    expect(result.out).not.toContain('services/y/base.ts');
    expect(result.out).toContain('config: config/loader.ts reads process.env');
    expect(result.out).not.toContain('main.ts');
  });

  it('still rejects a relative import into a forbidden layer', () => {
    file('common/a.ts', "import { b } from '../services/x/base.js';\nexport const a = b;\n");
    file('services/x/base.ts', 'export const b = 1;\n');
    expect(run().out).toContain('common: common/a.ts -> services/x/base.js');
  });

  it('accepts baselined violations and fails on a stale entry', () => {
    file('services/x/base.ts', "import yaml from 'js-yaml';\nexport default yaml;\n");
    const entry = "services: services/x/base.ts imports package 'js-yaml'";
    writeFileSync(baseline, JSON.stringify([entry, 'services: gone.ts reads process.env']));
    const result = run();
    expect(result.code).toBe(1);
    expect(result.out).toContain('services: gone.ts reads process.env');
    expect(result.out).toContain('--prune');
  });

  it('prunes stale entries and never adds new ones', () => {
    file('services/x/base.ts', "import yaml from 'js-yaml';\nexport default yaml;\n");
    writeFileSync(baseline, JSON.stringify(['services: gone.ts reads process.env']));
    const result = run('--prune');
    expect(result.code).toBe(1);
    expect(JSON.parse(readFileSync(baseline, 'utf8'))).toEqual([]);
  });

  it('rejects a malformed baseline', () => {
    writeFileSync(baseline, JSON.stringify({ not: 'an array' }));
    expect(run().code).not.toBe(0);
  });
});
