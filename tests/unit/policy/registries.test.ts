import { describe, expect, it } from 'vitest';
import { createReadonlyProbes, NO_READONLY_PROBES } from '../../../src/services/policy/breaker/readonly.js';
import { builtinReadonlyProbes, builtinShapes } from '../../../src/builtin-backends.js';
import { createShapeRegistry, NO_SHAPES } from '../../../src/services/policy/shape/registry.js';

describe('createShapeRegistry', () => {
  it('returns the entry for a known tool and undefined otherwise', () => {
    const shapes = { shape: () => null, baseShape: () => null };
    const registry = createShapeRegistry({ demo: shapes });
    expect(registry.shapesFor('demo')).toBe(shapes);
    expect(registry.shapesFor('other')).toBeUndefined();
  });

  it('NO_SHAPES knows no tool', () => {
    expect(NO_SHAPES.shapesFor('kubectl')).toBeUndefined();
  });

  it('builtinShapes covers kubectl only', () => {
    expect(builtinShapes.shapesFor('kubectl')).toBeDefined();
    expect(builtinShapes.shapesFor('gh')).toBeUndefined();
  });
});

describe('createReadonlyProbes', () => {
  it('delegates to the tool probe and defaults to false', () => {
    const probes = createReadonlyProbes({ demo: argv => argv[0] === 'ok' });
    expect(probes.isReadonly('demo', ['ok'])).toBe(true);
    expect(probes.isReadonly('demo', ['no'])).toBe(false);
    expect(probes.isReadonly('other', ['ok'])).toBe(false);
  });

  it('NO_READONLY_PROBES exempts nothing', () => {
    expect(NO_READONLY_PROBES.isReadonly('gh', ['pr', 'list'])).toBe(false);
  });
});

describe('builtinReadonlyProbes', () => {
  it('allows the closed gh vocabulary only', () => {
    expect(builtinReadonlyProbes.isReadonly('gh', ['pr', 'list'])).toBe(true);
    expect(builtinReadonlyProbes.isReadonly('gh', ['pr', 'list', '--json'])).toBe(false);
    expect(builtinReadonlyProbes.isReadonly('gh', ['pr', 'merge'])).toBe(false);
  });

  it('allows kubectl get of a plain kind only', () => {
    expect(builtinReadonlyProbes.isReadonly('kubectl', ['get', 'pods'])).toBe(true);
    expect(builtinReadonlyProbes.isReadonly('kubectl', ['get', 'secrets'])).toBe(false);
    expect(builtinReadonlyProbes.isReadonly('kubectl', ['get', 'pods', '-A'])).toBe(false);
    expect(builtinReadonlyProbes.isReadonly('kubectl', ['delete', 'pods'])).toBe(false);
  });
});
