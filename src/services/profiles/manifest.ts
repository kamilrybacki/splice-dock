import { z } from 'zod';
import { profileSchema } from '../../config/schema.js';
import type { ProfileConfig } from '../../config/types.js';

export const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_PROFILE_MANIFEST_BYTES = 64 * 1024;

const namedProfileSchema = profileSchema.extend({
  name: z.string().regex(PROFILE_NAME_PATTERN, 'profile name must be 1-64 alphanumeric/underscore/hyphen characters'),
});

/** Text format of a manifest (YAML in production). Parsing must yield plain JSON types. */
export interface ProfileManifestCodec {
  /** Throws ManifestSyntaxError on malformed text. */
  parse(text: string): unknown;
  dump(value: unknown): string;
}

/** Malformed manifest text, with the 1-based position when the codec knows it. */
export class ManifestSyntaxError extends Error {
  constructor(message: string, readonly position?: { line: number; column: number }) {
    super(message);
    this.name = 'ManifestSyntaxError';
  }
}

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

export function dumpProfileManifest(codec: ProfileManifestCodec, profile: ProfileConfig, name?: string): string {
  const value = name === undefined ? profile : { name, ...profile };
  return codec.dump(value);
}

/** Parse one profile document. Existing-profile documents omit `name`; creation
 * documents include it. The codec keeps values to plain JSON types. */
export function parseProfileManifest(codec: ProfileManifestCodec, manifest: string, expectedName?: string): ParsedProfileManifest {
  if (Buffer.byteLength(manifest, 'utf8') > MAX_PROFILE_MANIFEST_BYTES) {
    throw new ProfileManifestError(`profile manifest exceeds ${MAX_PROFILE_MANIFEST_BYTES} bytes`);
  }
  if (manifest.includes(String.fromCharCode(0))) throw new ProfileManifestError('profile manifest contains a NUL byte');

  let document: unknown;
  try {
    document = codec.parse(manifest);
  } catch (error) {
    const position = error instanceof ManifestSyntaxError ? error.position : undefined;
    throw new ProfileManifestError(error instanceof Error ? error.message : 'invalid YAML', position
      ? [{ path: [], message: `line ${position.line}, column ${position.column}` }]
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
