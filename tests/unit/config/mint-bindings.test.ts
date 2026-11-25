import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../../src/config-file.js';

function config(body: string): string {
  return `
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
  cli_whitelist: [gh]
${body}`;
}

const PROVIDERS = `credential_providers:
  gh:
    type: command
    command: /usr/local/bin/mint-gh
    ttl_seconds: 3000
`;

const TOOLS = `tools:
  - type: mcp_proxy
    name: vault
    service_dns: vault-mcp-svc.default.svc.cluster.local
    port: 8000
  - type: cli_passthrough
    name: gh
    description: GitHub CLI
    command: gh
`;

describe('credential_providers and mint bindings', () => {
  it('applies provider defaults when omitted', () => {
    const parsed = parseConfig(config(`${TOOLS}`));
    expect(parsed.credential_providers).toEqual({});
    expect(parsed.credential_storage).toEqual({
      type: 'vault',
      prefix: 'secret/data/splicedock/minted',
    });
    expect(parsed.credential_defaults).toEqual({});
  });

  it('accepts a command provider with defaults filled in', () => {
    const parsed = parseConfig(config(`${PROVIDERS}${TOOLS}`));
    expect(parsed.credential_providers['gh']).toEqual({
      type: 'command',
      command: '/usr/local/bin/mint-gh',
      args: [],
      timeout_ms: 10_000,
      ttl_seconds: 3000,
      max_ttl_seconds: 86_400,
      output: { format: 'text', secret_field: 'token' },
    });
  });

  it('accepts an explicit max_ttl_seconds on a command provider', () => {
    const parsed = parseConfig(config(`credential_providers:
  gh:
    type: command
    command: /usr/local/bin/mint-gh
    ttl_seconds: 3000
    max_ttl_seconds: 7200
${TOOLS}`));
    expect(parsed.credential_providers['gh']).toMatchObject({ ttl_seconds: 3000, max_ttl_seconds: 7200 });
  });

  it('rejects a ttl_seconds above max_ttl_seconds', () => {
    expect(() =>
      parseConfig(config(`credential_providers:
  gh:
    type: command
    command: /usr/local/bin/mint-gh
    ttl_seconds: 7200
    max_ttl_seconds: 3600
${TOOLS}`)),
    ).toThrow(/ttl_seconds must not exceed max_ttl_seconds/);
  });

  it('rejects a ttl_seconds above the default max_ttl_seconds', () => {
    expect(() =>
      parseConfig(config(`credential_providers:
  gh:
    type: command
    command: /usr/local/bin/mint-gh
    ttl_seconds: 172800
${TOOLS}`)),
    ).toThrow(/ttl_seconds must not exceed max_ttl_seconds/);
  });

  it.each([0, -1, 2_592_001])('rejects max_ttl_seconds of %i', value => {
    expect(() =>
      parseConfig(config(`credential_providers:
  gh:
    type: command
    command: /usr/local/bin/mint-gh
    max_ttl_seconds: ${value}
${TOOLS}`)),
    ).toThrow();
  });

  it('accepts mint bindings in a profile and in credential_defaults', () => {
    const parsed = parseConfig(config(`${PROVIDERS}profiles:
  worker:
    tools: ["vault__*", "gh__*"]
    credentials:
      vault:
        auth:
          type: bearer
          token: { mint: gh }
      gh:
        env:
          - name: GH_TOKEN
            mint: gh
credential_defaults:
  gh:
    env:
      - name: GH_TOKEN
        mint: gh
${TOOLS}`));
    expect(parsed.profiles['worker']!.credentials['vault']!.auth).toEqual({
      type: 'bearer',
      token: { mint: 'gh' },
    });
    expect(parsed.credential_defaults['gh']!.env).toEqual([{ name: 'GH_TOKEN', mint: 'gh' }]);
  });

  it('keeps the static from: form working next to mint:', () => {
    const parsed = parseConfig(config(`${PROVIDERS}profiles:
  worker:
    tools: ["vault__*"]
    credentials:
      vault:
        auth:
          type: header
          name: X-Api-Key
          value: { from: "vault:secret/data/vault#api_key" }
${TOOLS}`));
    expect(parsed.profiles['worker']!.credentials['vault']!.auth).toEqual({
      type: 'header',
      name: 'X-Api-Key',
      value: { from: 'vault:secret/data/vault#api_key' },
    });
  });

  it('rejects a mint naming an undeclared provider', () => {
    expect(() =>
      parseConfig(config(`profiles:
  worker:
    tools: ["vault__*"]
    credentials:
      vault:
        auth:
          type: bearer
          token: { mint: nope }
${TOOLS}`)),
    ).toThrow(/no credential_providers entry named 'nope'/);
  });

  it('rejects an undeclared provider in credential_defaults', () => {
    expect(() =>
      parseConfig(config(`credential_defaults:
  gh:
    env:
      - name: GH_TOKEN
        mint: nope
${TOOLS}`)),
    ).toThrow(/credential_defaults\.gh\.env: no credential_providers entry named 'nope'/);
  });

  it('rejects mint on a tool-level auth, which has no profile identity', () => {
    expect(() =>
      parseConfig(config(`${PROVIDERS}tools:
  - type: mcp_proxy
    name: vault
    service_dns: vault-mcp-svc.default.svc.cluster.local
    port: 8000
    auth:
      type: bearer
      token: { mint: gh }
`)),
    ).toThrow(/is only valid in profiles\.<name>\.credentials/);
  });

  it('rejects mint on tool-level cli env, resolved at startup', () => {
    expect(() =>
      parseConfig(config(`${PROVIDERS}tools:
  - type: cli_passthrough
    name: gh
    description: GitHub CLI
    command: gh
    env:
      - name: GH_TOKEN
        mint: gh
`)),
    ).toThrow(/is only valid in profiles\.<name>\.credentials/);
  });

  it('rejects an unknown provider type', () => {
    expect(() =>
      parseConfig(config(`credential_providers:
  gh:
    type: telepathy
${TOOLS}`)),
    ).toThrow();
  });
});
