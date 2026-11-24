import yaml from 'js-yaml';
import { z } from 'zod';
import { profileSchema } from '../../config/schema.js';
import type { ProfileConfig } from '../../config/types.js';

export const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_PROFILE_MANIFEST_BYTES = 64 * 1024;

const DUMP_OPTS: yaml.DumpOptions = { indent: 2, lineWidth: 120, noRefs: true };
const namedProfileSchema = profileSchema.extend({
  name: z.string().regex(PROFILE_NAME_PATTERN, 'profile name must be 1-64 alphanumeric/underscore/hyphen characters'),
});

export interface ParsedProfileManifest {
  name: string;
  profile: ProfileConfig;
}

export class ProfileManifestError extends Error {
  constructor(
    message: string,
    readonly details: Array<{ path: Array<string | number>; message: string }> = [],
  ) {
    super(message);
    this.name = 'ProfileManifestError';
  }
}

export function dumpProfileManifest(profile: ProfileConfig, name?: string): string {
  const value = name === undefined ? profile : { name, ...profile };
  return yaml.dump(value, DUMP_OPTS);
}

/** Parse one profile document. Existing-profile documents omit `name`; creation
 * documents include it. JSON_SCHEMA keeps YAML values to plain JSON types. */
export function parseProfileManifest(manifest: string, expectedName?: string): ParsedProfileManifest {
  if (Buffer.byteLength(manifest, 'utf8') > MAX_PROFILE_MANIFEST_BYTES) {
    throw new ProfileManifestError(`profile manifest exceeds ${MAX_PROFILE_MANIFEST_BYTES} bytes`);
  }
  if (manifest.includes(String.fromCharCode(0))) throw new ProfileManifestError('profile manifest contains a NUL byte');

  let document: unknown;
  try {
    document = yaml.load(manifest, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    const mark = error instanceof yaml.YAMLException ? error.mark : undefined;
    throw new ProfileManifestError(error instanceof Error ? error.message : 'invalid YAML', mark
      ? [{ path: [], message: `line ${mark.line + 1}, column ${mark.column + 1}` }]
      : []);
  }

  if (expectedName === undefined) {
    const parsed = namedProfileSchema.safeParse(document);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const { name, ...profile } = parsed.data;
    assertNoPrototypeKeys(profile);
    return { name, profile };
  }

  const parsed = profileSchema.safeParse(document);
  if (!parsed.success) throw validationError(parsed.error.issues);
  assertNoPrototypeKeys(parsed.data);
  return { name: expectedName, profile: parsed.data };
}

function validationError(issues: z.core.$ZodIssue[]): ProfileManifestError {
  return new ProfileManifestError('Invalid profile manifest', issues.map(issue => ({
    path: issue.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number'),
    message: issue.message,
  })));
}

function assertNoPrototypeKeys(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (/(?:^|[,{])"(?:__proto__|prototype|constructor)"\s*:/.test(serialized)) {
    throw new ProfileManifestError('profile manifest contains a forbidden object key');
  }
}
