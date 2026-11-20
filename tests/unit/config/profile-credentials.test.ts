import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../../src/config/loader.js';

function configWith(profiles: string, tools: string = '  []'): string {
  return `
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
  cli_whitelist: [gh]
profiles:
${profiles}
tools:
${tools}`;
}

const VAULT_TOOL = `  - type: mcp_proxy
    name: vault
    service_dns: vault-mcp-svc.default.svc.cluster.local
    port: 8000
`;

const GH_TOOL = `  - type: cli_passthrough
    name: gh
    description: GitHub CLI
    command: gh
`;

describe('profiles.<name>.credentials', () => {
  it('defaults to an empty map when absent', () => {
    const config = parseConfig(configWith('  default:\n    tools: ["*"]'));
    expect(config.profiles['default']!.credentials).toEqual({});
  });

  it('accepts an mcp_proxy auth override', () => {
    const config = parseConfig(
      configWith(
        `  worker:
    tools: ["vault__*"]
    credentials:
      vault:
        auth:
          type: bearer
          token: { from: "vault:secret/data/splicedock#worker_token" }`,
        VAULT_TOOL,
      ),
    );
    expect(config.profiles['worker']!.credentials['vault']!.auth).toEqual({
      type: 'bearer',
      token: { from: 'vault:secret/data/splicedock#worker_token' },
    });
  });

  it('accepts a cli_passthrough env override', () => {
    const config = parseConfig(
      configWith(
        `  worker:
    tools: ["gh__*"]
    credentials:
      gh:
        env:
          - name: GH_TOKEN
            from: "vault:secret/data/github#worker_pat"`,
        GH_TOOL,
      ),
    );
    expect(config.profiles['worker']!.credentials['gh']!.env).toEqual([
      { name: 'GH_TOKEN', from: 'vault:secret/data/github#worker_pat' },
    ]);
  });

  it('rejects a credential for an unknown tool name', () => {
    expect(() =>
      parseConfig(
        configWith(
          `  worker:
    tools: ["*"]
    credentials:
      vaul:
        auth:
          type: bearer
          token: { from: "env:TOKEN" }`,
          VAULT_TOOL,
        ),
      ),
    ).toThrow(/credentials\.vaul: no tool named 'vaul'/);
  });

  it('rejects auth on a cli_passthrough tool', () => {
    expect(() =>
      parseConfig(
        configWith(
          `  worker:
    tools: ["*"]
    credentials:
      gh:
        auth:
          type: bearer
          token: { from: "env:TOKEN" }`,
          GH_TOOL,
        ),
      ),
    ).toThrow(/only valid for mcp_proxy and http tools/);
  });

  it('rejects env on an mcp_proxy tool', () => {
    expect(() =>
      parseConfig(
        configWith(
          `  worker:
    tools: ["*"]
    credentials:
      vault:
        env:
          - name: TOKEN
            from: "env:TOKEN"`,
          VAULT_TOOL,
        ),
      ),
    ).toThrow(/'env' is only valid for cli_passthrough tools/);
  });

  it('rejects a credential that sets both auth and env', () => {
    expect(() =>
      parseConfig(
        configWith(
          `  worker:
    tools: ["*"]
    credentials:
      vault:
        auth: { type: none }
        env:
          - name: TOKEN
            from: "env:TOKEN"`,
          VAULT_TOOL,
        ),
      ),
    ).toThrow(/exactly one of 'auth' or 'env'/);
  });

  it('rejects a credential that sets neither auth nor env', () => {
    expect(() =>
      parseConfig(
        configWith(
          `  worker:
    tools: ["*"]
    credentials:
      vault: {}`,
          VAULT_TOOL,
        ),
      ),
    ).toThrow(/exactly one of 'auth' or 'env'/);
  });

  it('rejects an auth ref that is not env: or vault:', () => {
    expect(() =>
      parseConfig(
        configWith(
          `  worker:
    tools: ["*"]
    credentials:
      vault:
        auth:
          type: bearer
          token: { from: "file:/tmp/token" }`,
          VAULT_TOOL,
        ),
      ),
    ).toThrow();
  });
});
