import { readFileSync } from 'node:fs';

// package.json sits in the package root, one level above both src/
// (tests) and dist/ (build, and the installed npm package).
const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

function readPackageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf8'));
  const version = (parsed as { version?: unknown } | null)?.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('package.json has no version');
  }
  return version;
}

/** Splicedock's own version, read once from package.json at module load. */
export const PACKAGE_VERSION: string = readPackageVersion();
