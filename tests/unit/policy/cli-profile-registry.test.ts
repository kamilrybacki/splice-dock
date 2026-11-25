import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandBasename,
  createCliProfileRegistry,
  NO_CLI_PROFILES,
  type CliProfile,
} from '../../../src/services/policy/cli/profiles/index.js';
import { callCliPassthrough, configurePassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';
import { builtinCliProfiles } from '../../helpers/cli-profiles.js';

const profile = (name: string): CliProfile =>
  ({ name, flags: { long: new Map(), short: new Map() }, knownCommands: {}, optionAliases: {} }) as unknown as CliProfile;

describe('createCliProfileRegistry', () => {
  it('matches a command by basename', () => {
    const demo = profile('demo');
    const registry = createCliProfileRegistry([demo]);
    expect(registry.profileFor('demo')).toBe(demo);
    expect(registry.profileFor('/opt/bin/demo')).toBe(demo);
    expect(registry.profileFor('demo2')).toBeUndefined();
    expect(registry.profileFor(undefined)).toBeUndefined();
    expect(registry.profileFor('')).toBeUndefined();
  });

  it('rejects two profiles with one name', () => {
    expect(() => createCliProfileRegistry([profile('x'), profile('x')])).toThrow(/duplicate CLI profile: x/);
  });

  it('NO_CLI_PROFILES knows no CLI', () => {
    expect(NO_CLI_PROFILES.profileFor('gh')).toBeUndefined();
    expect(NO_CLI_PROFILES.profileFor('kubectl')).toBeUndefined();
  });

  it('commandBasename strips the directory', () => {
    expect(commandBasename('/usr/local/bin/gh')).toBe('gh');
    expect(commandBasename('gh')).toBe('gh');
  });

  it('builtinCliProfiles ships gh and kubectl only', () => {
    expect(builtinCliProfiles.profileFor('gh')?.name).toBe('gh');
    expect(builtinCliProfiles.profileFor('/usr/bin/kubectl')?.name).toBe('kubectl');
    expect(builtinCliProfiles.profileFor('codex')).toBeUndefined();
  });
});

describe('passthrough takes CLI rules only from the injected registry', () => {
  afterEach(() => configurePassthrough({}));

  async function runFakeGh(args: string[]): Promise<boolean | undefined> {
    const dir = mkdtempSync(join(tmpdir(), 'splicedock-test-'));
    const command = join(dir, 'gh');
    try {
      writeFileSync(command, '#!/bin/sh\necho ok\n', { mode: 0o700 });
      const config: CliPassthroughToolConfig = {
        type: 'cli_passthrough', name: 'fake_gh', description: 'fake gh', command, env: [], timeout_ms: 5000,
      };
      const r = await callCliPassthrough(config, 'run', { args }, [command]);
      return r.isError;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('without a registry, `gh api` is not hard-denied', async () => {
    configurePassthrough({});
    expect(await runFakeGh(['api', 'x'])).toBeFalsy();
  });

  it('with the builtin registry, `gh api` is hard-denied', async () => {
    configurePassthrough({ cliProfiles: builtinCliProfiles });
    expect(await runFakeGh(['api', 'x'])).toBe(true);
  });
});
