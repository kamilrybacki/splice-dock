// Invocations that exist to print a credential are refused before the CLI spawns.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runWithCaller } from '../../../src/common/request/context.js';
import { credentialDenyMessage, findCredentialDeny } from '../../../src/services/policy/cli/credential-deny.js';
import { callCliPassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import { builtinCliProfiles, cliProfile, useBuiltinCliProfiles } from '../../helpers/cli-profiles.js';

useBuiltinCliProfiles();

const caller = { profile: 'test', tokenId: 'one', authenticated: true };
const tool = {
  type: 'cli_passthrough' as const, name: 'gh', command: 'gh',
  description: 'test', env: [], timeout_ms: 5000,
};

// A fake `gh` first on PATH. It leaves a marker file when it is spawned, so a
// test can tell "refused before spawn" from "ran and printed nothing".
let binDir: string;
let marker: string;
let savedPath: string | undefined;
beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'fake-gh-deny-'));
  marker = join(binDir, 'spawned');
  writeFileSync(join(binDir, 'gh'), `#!/bin/sh\ntouch '${marker}'\necho "fake gh $*"\n`);
  chmodSync(join(binDir, 'gh'), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${savedPath ?? ''}`;
});
beforeEach(() => rmSync(marker, { force: true }));
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(binDir, { recursive: true, force: true });
});

const callGh = (args: string[]) =>
  runWithCaller(caller, () => callCliPassthrough(tool, 'run', { args }, ['gh']));

const DENIED: ReadonlyArray<readonly [string, string[], string]> = [
  ['auth token', ['auth', 'token'], 'gh_auth_token'],
  ['auth token with a host', ['auth', 'token', '--hostname', 'github.com'], 'gh_auth_token'],
  ['auth status --show-token', ['auth', 'status', '--show-token'], 'gh_auth_status_show_token'],
  ['auth status -t', ['auth', 'status', '-t'], 'gh_auth_status_show_token'],
  ['auth status with a flag before -t', ['auth', 'status', '--hostname', 'github.com', '-t'], 'gh_auth_status_show_token'],
  ['--jq env.GH_TOKEN', ['pr', 'list', '--json', 'number', '--jq', 'env.GH_TOKEN'], 'gh_jq_env'],
  ['--jq=env.GH_TOKEN', ['pr', 'list', '--json', 'number', '--jq=env.GH_TOKEN'], 'gh_jq_env'],
  ['-q env.GH_TOKEN', ['pr', 'list', '--json', 'number', '-q', 'env.GH_TOKEN'], 'gh_jq_env'],
  ['-qEXPR attached', ['pr', 'list', '--json', 'number', '-qenv.GH_TOKEN'], 'gh_jq_env'],
  ['--jq $ENV.GH_TOKEN', ['issue', 'list', '--json', 'number', '--jq', '$ENV.GH_TOKEN'], 'gh_jq_env'],
  ['--jq with env in a pipeline', ['pr', 'list', '--json', 'number', '--jq', '.[] | env | .GH_TOKEN'], 'gh_jq_env'],
  ['--jq env["GH_TOKEN"]', ['pr', 'list', '--json', 'number', '--jq', 'env["GH_TOKEN"]'], 'gh_jq_env'],
];

describe('cli_passthrough credential-printing denies (gh)', () => {
  it.each(DENIED)('refuses %s before spawn', async (_label, args, ruleId) => {
    const out = await callGh(args);
    expect(out.isError).toBe(true);
    const text = out.content[0]!.text;
    expect(text).toContain('credential_print_denied');
    expect(text).toContain(ruleId);
    expect(existsSync(marker)).toBe(false);
  });

  const ALLOWED: ReadonlyArray<readonly [string, string[]]> = [
    ['pr list', ['pr', 'list']],
    ['auth status', ['auth', 'status']],
    ['pr create with -t as --title', ['pr', 'create', '-t', 'my title', '-b', 'body']],
    ['--jq reading a field named env', ['pr', 'list', '--json', 'number', '--jq', '.foo.env']],
    ['--jq with an ordinary filter', ['pr', 'list', '--json', 'number,title', '-q', '.[] | .title']],
    ['--jq on a word that merely contains env', ['pr', 'list', '--json', 'number', '--jq', '.[] | .environment']],
  ];

  it.each(ALLOWED)('still runs %s', async (_label, args) => {
    const out = await callGh(args);
    expect(out.content[0]!.text).not.toContain('credential_print_denied');
    expect(out.isError).toBeFalsy();
    expect(existsSync(marker)).toBe(true);
  });
});

describe('findCredentialDeny (gh rules)', () => {
  const profile = cliProfile('gh')!;
  const find = (argv: string[]) =>
    findCredentialDeny(argv, profile.credentialDenies, {
      table: profile.flags,
      knownCommands: profile.knownCommands,
    });

  it('matches the gh api --template/-t rule, which the passthrough reaches only via a broker', () => {
    expect(find(['api', 'user', '--template', '{{env "GH_TOKEN"}}'])?.id).toBe('gh_api_template_env');
    expect(find(['api', 'user', '-t', '{{env "GH_TOKEN"}}'])?.id).toBe('gh_api_template_env');
    expect(find(['api', 'user', '--template={{env "GH_TOKEN"}}'])?.id).toBe('gh_api_template_env');
  });

  it('matches the jq rule on gh api as well', () => {
    expect(find(['api', 'user', '--jq', 'env.GH_TOKEN'])?.id).toBe('gh_jq_env');
    expect(find(['api', 'user', '-q', 'env.GH_TOKEN'])?.id).toBe('gh_jq_env');
  });

  it('leaves api calls with ordinary templates and filters alone', () => {
    expect(find(['api', 'user', '--template', '{{.login}}'])).toBeUndefined();
    expect(find(['api', 'user', '--jq', '.login'])).toBeUndefined();
  });

  it('does not read -t as a template outside gh api (it is --title)', () => {
    expect(find(['pr', 'create', '-t', 'env'])).toBeUndefined();
    expect(find(['issue', 'edit', '1', '-t', 'env'])).toBeUndefined();
  });

  it('ignores flags after --', () => {
    expect(find(['pr', 'list', '--', '--jq', 'env.GH_TOKEN'])).toBeUndefined();
  });

  it('returns nothing without rules (a CLI with no credential denies)', () => {
    expect(findCredentialDeny(['auth', 'token'], undefined, { table: profile.flags })).toBeUndefined();
    expect(findCredentialDeny(['auth', 'token'], [], { table: profile.flags })).toBeUndefined();
  });

  it('is extensible: a rule for another CLI works with the same matcher', () => {
    const rules = [{ id: 'x_print', reason: 'prints a secret', path: ['show', 'secret'] }] as const;
    const hit = findCredentialDeny(['show', 'secret'], rules, { table: profile.flags });
    expect(hit?.id).toBe('x_print');
    expect(credentialDenyMessage(hit!)).toBe('Denied: prints a secret (credential_print_denied:x_print)');
    expect(findCredentialDeny(['show', 'other'], rules, { table: profile.flags })).toBeUndefined();
  });

  it('the registry exposes the gh rules', () => {
    expect(builtinCliProfiles.profileFor('gh')?.credentialDenies?.length).toBeGreaterThan(0);
  });
});
