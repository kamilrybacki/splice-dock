#!/usr/bin/env node
// Enforces the hexagonal layer rules in src/ (see docs/architecture.md).
// Each layer may import only from the layers listed for it; adapters and the
// composition root (src/*.ts) may import anything. Exits 1 on any violation.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SRC = resolve(process.argv[2] ?? 'src');

const ALLOWED = {
  common: ['common'],
  domain: ['domain', 'config', 'common'],
  config: ['config', 'domain', 'common'],
  ports: ['ports', 'domain', 'config', 'common'],
  application: ['application', 'ports', 'domain', 'config', 'common'],
  adapters: '*',
  root: '*',
};

const IMPORT = /(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g;

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function layerOf(file) {
  const parts = relative(SRC, file).split(sep);
  return parts.length === 1 ? 'root' : parts[0];
}

const violations = [];
for (const file of walk(SRC).filter(f => f.endsWith('.ts'))) {
  const layer = layerOf(file);
  const allowed = ALLOWED[layer];
  if (allowed === undefined) {
    violations.push(`${relative(SRC, file)}: unknown layer '${layer}'`);
    continue;
  }
  if (allowed === '*') continue;
  for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    const target = resolve(dirname(file), match[1]);
    const targetLayer = layerOf(target);
    if (!allowed.includes(targetLayer)) {
      violations.push(`${layer}: ${relative(SRC, file)} -> ${relative(SRC, target)}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`Layer violations (${violations.length}):\n  ${violations.join('\n  ')}`);
  process.exit(1);
}
console.log('layers: ok');
