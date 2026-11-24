import yaml from 'js-yaml';
import type { ProfileConfig } from '../../../config/types.js';
import {
  dumpProfileManifest as dump,
  ManifestSyntaxError,
  parseProfileManifest as parse,
  type ParsedProfileManifest,
  type ProfileManifestCodec,
} from '../manifest.js';

const DUMP_OPTS: yaml.DumpOptions = { indent: 2, lineWidth: 120, noRefs: true };

/** YAML codec; JSON_SCHEMA keeps parsed values to plain JSON types. */
export const yamlManifestCodec: ProfileManifestCodec = {
  parse(text) {
    try {
      return yaml.load(text, { schema: yaml.JSON_SCHEMA });
    } catch (error) {
      const mark = error instanceof yaml.YAMLException ? error.mark : undefined;
      throw new ManifestSyntaxError(
        error instanceof Error ? error.message : 'invalid YAML',
        mark ? { line: mark.line + 1, column: mark.column + 1 } : undefined,
      );
    }
  },
  dump: value => yaml.dump(value, DUMP_OPTS),
};

export function dumpProfileManifest(profile: ProfileConfig, name?: string): string {
  return dump(yamlManifestCodec, profile, name);
}

export function parseProfileManifest(manifest: string, expectedName?: string): ParsedProfileManifest {
  return parse(yamlManifestCodec, manifest, expectedName);
}
