#!/usr/bin/env node
// Enforces dependency directions across the service and contract boundaries.
// See docs/architecture.md.
//
// Four rules, applied to every layer except adapters and the composition root:
//   1. relative imports must point at an allowed layer (ALLOWED);
//   2. package imports (node:*, npm) must be on the layer's allowlist (PACKAGES);
//   3. process.env may not be read (ENV_ALLOWED lists the exceptions);
//   4. no SQL-backend-specific code (BACKEND_PATTERNS).
//
// Known violations live in scripts/layers-baseline.json. The baseline can only
// shrink: a new violation fails, and so does an entry that no longer occurs.
// `--prune` rewrites the baseline without the stale entries; it never adds any.
//
// Usage: node scripts/check-layers.mjs [srcDir] [--baseline <file>] [--prune]

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--baseline');

const SRC = resolve(positional[0] ?? 'src');
const BASELINE = resolve(
  option('--baseline') ?? join(dirname(fileURLToPath(import.meta.url)), 'layers-baseline.json'),
);
const PRUNE = flag('--prune');

const ALLOWED = {
  common: ['common'],
  contracts: ['common', 'config', 'contracts'],
  config: ['common', 'config', 'contracts', 'services'],
  services: ['common', 'config', 'contracts', 'services'],
  adapters: '*',
  root: '*',
};

// Pure, backend-free packages each layer may import. Anything that talks to
// the outside world (fs, http, a database, a metrics backend, a protocol SDK)
// belongs in an adapter.
const PACKAGES = {
  common: ['node:async_hooks', 'node:crypto'],
  contracts: [],
  config: ['zod'],
  services: ['node:crypto', 'node:path', 'node:timers/promises', 'zod', 'minimatch'],
  adapters: '*',
  root: '*',
};

// Files outside adapters and the root that may read process.env.
const ENV_ALLOWED = ['config/loader.ts'];

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const posix = path => path.split(sep).join('/');

function layerOf(file) {
  const parts = relative(SRC, file).split(sep);
  if (parts[0] === '..') return 'outside';
  if (parts.length === 1) return 'root';
  if (parts[0] === 'services') {
    if (parts.length < 3) return 'unknown';
    return parts[2] === 'adapters' ? 'adapters' : 'services';
  }
  if (parts[0] === 'contracts' && !['internal', 'outbound', 'inbound'].includes(parts[1])) {
    return 'unknown';
  }
  return parts[0];
}

// Domain code must not know which SQL backend it runs on: that lives behind
// the SqlDb contract and in adapters. Comment lines are ignored.
const BACKEND_PATTERNS = [
  /\.dialect\b/, /isPostgres/, /pg_advisory/, /FOR UPDATE/, /SKIP LOCKED/, /hashtextextended/,
  /\bfrom\s+['"]pg['"]/, /\bfrom\s+['"]better-sqlite3['"]/,
  /\brequire\(\s*['"](?:pg|better-sqlite3)['"]\s*\)/, /\bimport\(\s*['"](?:pg|better-sqlite3)['"]\s*\)/,
];

function backendLeaks(source, rel, layer) {
  const found = [];
  let inBlock = false;
  source.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
    if (t.startsWith('//') || t.startsWith('*')) return;
    const hit = BACKEND_PATTERNS.find(re => re.test(line));
    if (hit) found.push(`${layer}: ${rel}:${i + 1}: backend-specific code ${hit}`);
  });
  return found;
}

// Package name without a subpath: '@scope/pkg/x.js' -> '@scope/pkg', 'pkg/x' -> 'pkg'.
function packageOf(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// AST match, so comments and strings that mention process.env do not count.
function readsProcessEnv(source, file) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const isProcess = node => ts.isIdentifier(node) && node.text === 'process';
  const isEnvAccess = node =>
    (ts.isPropertyAccessExpression(node) && isProcess(node.expression) && node.name.text === 'env') ||
    (ts.isElementAccessExpression(node) &&
      isProcess(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'env');
  const visit = node => isEnvAccess(node) || ts.forEachChild(node, visit) === true;
  return visit(sf);
}

function checkFile(file) {
  const rel = posix(relative(SRC, file));
  const layer = layerOf(file);
  const allowed = ALLOWED[layer];
  if (allowed === undefined) return [`${rel}: unknown layer '${layer}'`];
  if (allowed === '*') return [];

  const source = readFileSync(file, 'utf8');
  const found = backendLeaks(source, rel, layer);
  const { importedFiles } = ts.preProcessFile(source, true, true);
  for (const { fileName } of importedFiles) {
    if (fileName.startsWith('./') || fileName.startsWith('../')) {
      const target = resolve(dirname(file), fileName);
      if (!allowed.includes(layerOf(target))) {
        found.push(`${layer}: ${rel} -> ${posix(relative(SRC, target))}`);
      }
    } else if (!PACKAGES[layer].includes(packageOf(fileName))) {
      found.push(`${layer}: ${rel} imports package '${packageOf(fileName)}'`);
    }
  }
  if (!ENV_ALLOWED.includes(rel) && readsProcessEnv(source, file)) {
    found.push(`${layer}: ${rel} reads process.env`);
  }
  return found;
}

function loadBaseline() {
  if (!existsSync(BASELINE)) return [];
  const data = JSON.parse(readFileSync(BASELINE, 'utf8'));
  if (!Array.isArray(data) || !data.every(entry => typeof entry === 'string')) {
    throw new Error(`${BASELINE}: expected a JSON array of strings`);
  }
  return data;
}

const current = [
  ...new Set(
    walk(SRC)
      .filter(f => f.endsWith('.ts'))
      .flatMap(checkFile),
  ),
].sort();
const baseline = loadBaseline();
const baselineSet = new Set(baseline);
const currentSet = new Set(current);
const fresh = current.filter(v => !baselineSet.has(v));
const stale = baseline.filter(v => !currentSet.has(v));
const kept = baseline.filter(v => currentSet.has(v));

if (PRUNE && stale.length > 0) {
  writeFileSync(BASELINE, `${JSON.stringify(kept, null, 2)}\n`);
  console.log(`layers: pruned ${stale.length} fixed violation(s) from the baseline`);
}

let failed = false;
if (fresh.length > 0) {
  console.error(`Layer violations (${fresh.length}):\n  ${fresh.join('\n  ')}`);
  failed = true;
}
if (stale.length > 0 && !PRUNE) {
  console.error(
    `Fixed violations still listed in the baseline (${stale.length}); run with --prune:\n  ${stale.join('\n  ')}`,
  );
  failed = true;
}
if (failed) process.exit(1);
console.log(`layers: ok (${kept.length} baselined)`);
