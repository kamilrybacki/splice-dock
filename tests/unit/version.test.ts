import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PACKAGE_VERSION } from '../../src/common/version.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

describe('PACKAGE_VERSION', () => {
  it('equals the version in package.json', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});
