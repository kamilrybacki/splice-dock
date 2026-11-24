import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PINNED_GH_VERSION } from '../../../src/services/policy/cli/gh/version.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file: string): string => readFileSync(root + file, 'utf8');

describe('gh version pin', () => {
  it('is an exact 2.102.x version', () => {
    expect(PINNED_GH_VERSION).toMatch(/^2\.102\.\d+$/);
  });

  describe('Dockerfile', () => {
    const dockerfile = read('Dockerfile');
    it('declares the pinned version once', () => {
      expect(dockerfile.match(/^ARG GH_VERSION=.*$/gm)).toEqual([`ARG GH_VERSION=${PINNED_GH_VERSION}`]);
    });
    it('installs exactly that version from an official GitHub release tarball', () => {
      expect(dockerfile).toContain('https://github.com/cli/cli/releases/download/v${GH_VERSION}/$archive');
      expect(dockerfile).toContain('archive="gh_${GH_VERSION}_linux_${arch}.tar.gz"');
      expect(dockerfile).toContain('gh --version | grep -q "^gh version ${GH_VERSION} "');
      expect(dockerfile).not.toContain('cli.github.com/packages');
    });
    it('verifies both architectures with the same hardcoded digests as CI', () => {
      const workflow = read('.github/workflows/ci.yml');
      const digests = [
        'bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386',
        '7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484',
      ];
      for (const digest of digests) {
        expect(dockerfile).toContain(`sha256=${digest}`);
        expect(workflow).toContain(`sha256=${digest}`);
      }
      expect(dockerfile).toContain('sha256sum --check --strict');
      expect(workflow).toContain('sha256sum --check --strict');
      expect(dockerfile.indexOf('sha256sum')).toBeLessThan(dockerfile.indexOf('tar -xzf'));
      expect(workflow.indexOf('sha256sum')).toBeLessThan(workflow.indexOf('tar -xzf'));
    });
    it('never installs an unpinned gh package', () => {
      const installs = dockerfile.replace(/\\\n/g, ' ').split(/&&|;|\n/).filter(s => /\bapt-get install\b/.test(s));
      expect(installs.length).toBeGreaterThan(0);
      for (const cmd of installs) expect(cmd.split(/\s+/).map(t => t.replace(/"/g, ''))).not.toContain('gh');
    });
  });

  it('the example config self-provisions the same version', () => {
    expect(read('splicedock.example.yaml')).toContain(`GH_VERSION: "${PINNED_GH_VERSION}"`);
  });
});
