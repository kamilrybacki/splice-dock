#!/usr/bin/env node
// Enforces dependency directions across the service and contract boundaries.
// See docs/architecture.md.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const SRC = resolve(process.argv[2] ?? 'src');

const ALLOWED = {
  common: ['common'],
  contracts: ['common', 'config', 'contracts'],
  config: ['common', 'config', 'contracts', 'services'],
  services: ['common', 'config', 'contracts', 'services'],
  adapters: '*',
  root: '*',
};

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

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

const violations = [];
for (const file of walk(SRC).filter(f => f.endsWith('.ts'))) {
  const layer = layerOf(file);
  const allowed = ALLOWED[layer];
  if (allowed === undefined) {
    violations.push(`${relative(SRC, file)}: unknown layer '${layer}'`);
    continue;
  }
  if (allowed === '*') continue;
  const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
  for (const { fileName } of importedFiles) {
    if (!fileName.startsWith('./') && !fileName.startsWith('../')) continue;
    const target = resolve(dirname(file), fileName);
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
