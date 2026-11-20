// tests/unit/config/loader.test.ts
import { describe, it, expect } from 'vitest';
import { parseConfig, loadConfig } from '../../../src/config/loader.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MINIMAL_YAML = `
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
profiles: {}
tools: []
`;

const WITH_HTTP_TOOL = `
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
  cli_whitelist: [kubectl, helm]
profiles:
  coding:
    tools:
      - "github__*"
tools:
  - type: http
    name: get_issue
    namespace: github
    description: "Get a GitHub issue"
    method: GET
    url: "https://api.github.com/repos/{owner}/{repo}/issues/{number}"
    params:
      - name: owner
        in: path
        required: true
      - name: repo
        in: path
        required: true
      - name: number
        in: path
        required: true
    auth:
      type: bearer
      token:
        from: "env:GITHUB_TOKEN"
`;

describe('parseConfig', () => {
  it('parses minimal valid config', () => {
    const cfg = parseConfig(MINIMAL_YAML);
    expect(cfg.server.port).toBe(8788);
    expect(cfg.server.admin_port).toBe(8789);
    expect(cfg.tools).toHaveLength(0);
  });

  it('parses HTTP tool with bearer auth', () => {
    const cfg = parseConfig(WITH_HTTP_TOOL);
    expect(cfg.tools).toHaveLength(1);
    const tool = cfg.tools[0];
    expect(tool.type).toBe('http');
    if (tool.type === 'http') {
      expect(tool.namespace).toBe('github');
      expect(tool.auth.type).toBe('bearer');
    }
  });

  it('throws on invalid YAML', () => {
    expect(() => parseConfig('{')).toThrow();
  });

  it('throws when tool type is unknown', () => {
    const bad = MINIMAL_YAML.replace('tools: []', `tools:\n  - type: unknown\n    name: foo`);
    expect(() => parseConfig(bad)).toThrow();
  });

  it('throws when auth from: value has invalid prefix', () => {
    const bad = WITH_HTTP_TOOL.replace('env:GITHUB_TOKEN', 'badprefix:TOKEN');
    expect(() => parseConfig(bad)).toThrow();
  });

  it('throws on empty YAML with a human-readable error', () => {
    expect(() => parseConfig('')).toThrow(/empty or contains only comments/);
    expect(() => parseConfig('# just a comment')).toThrow(/empty or contains only comments/);
  });

  it('parses mcp_proxy tool', () => {
    const cfg = parseConfig(`
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
profiles: {}
tools:
  - type: mcp_proxy
    name: notes
    service_dns: "notes-mcp-headless.default.svc.cluster.local"
    port: 8080
    refresh_interval_ms: 600000
    retry:
      max_attempts: 3
      backoff_ms: 500
`);
    expect(cfg.tools).toHaveLength(1);
    const tool = cfg.tools[0];
    expect(tool.type).toBe('mcp_proxy');
    if (tool.type === 'mcp_proxy') {
      expect(tool.name).toBe('notes');
      expect(tool.service_dns).toBe('notes-mcp-headless.default.svc.cluster.local');
      expect(tool.port).toBe(8080);
      expect(tool.refresh_interval_ms).toBe(600_000);
      expect(tool.retry?.max_attempts).toBe(3);
    }
  });

  it('parses cli tool with correct defaults', () => {
    const cfg = parseConfig(`
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
profiles: {}
tools:
  - type: cli
    name: kubectl_get
    namespace: cli
    description: "Run kubectl get"
    command: kubectl
    args: ["get", "{resource}"]
    params:
      - name: resource
        required: true
    env: [KUBECONFIG]
`);
    const tool = cfg.tools[0];
    expect(tool.type).toBe('cli');
    if (tool.type === 'cli') {
      expect(tool.timeout_ms).toBe(30000);
      expect(tool.auth).toBe('none');
      expect(tool.args).toEqual(['get', '{resource}']);
    }
  });

  it('rejects cli tool with path-traversal in command', () => {
    expect(() => parseConfig(`
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
profiles: {}
tools:
  - type: cli
    name: bad
    namespace: cli
    description: "bad"
    command: ../../../bin/sh
    args: []
`)).toThrow();
  });

  it('applies server defaults when server section is omitted', () => {
    const cfg = parseConfig('profiles: {}\ntools: []\n');
    expect(cfg.server.port).toBe(8788);
    expect(cfg.server.admin_port).toBe(8789);
    expect(cfg.server.cli_whitelist).toEqual([]);
  });

  it('rejects out-of-range port', () => {
    expect(() => parseConfig(`
server:
  port: 99999
  admin_port: 8789
  admin_token_env: TOKEN
profiles: {}
tools: []
`)).toThrow();
  });
});

describe('parseConfig — cli_passthrough policy shim', () => {
  it('folds legacy top-level deny_subcommands into policy.deny_subcommands', () => {
    const cfg = parseConfig(`
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
  cli_whitelist: [echo]
profiles: {}
tools:
  - type: cli_passthrough
    name: echo_tool
    description: "echo for tests"
    command: echo
    deny_subcommands: [delete]
`);
    const tool = cfg.tools[0];
    expect(tool.type).toBe('cli_passthrough');
    if (tool.type === 'cli_passthrough') {
      expect(tool.policy?.deny_subcommands).toEqual(['delete']);
    }
  });

  it('rejects setting deny_subcommands at both legacy + policy locations', () => {
    expect(() =>
      parseConfig(`
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
  cli_whitelist: [echo]
profiles: {}
tools:
  - type: cli_passthrough
    name: echo_tool
    description: "echo for tests"
    command: echo
    deny_subcommands: [delete]
    policy:
      deny_subcommands: [edit]
`),
    ).toThrow(/deny_subcommands/);
  });

  it('accepts policy.allow_subcommands with no legacy field', () => {
    const cfg = parseConfig(`
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
  cli_whitelist: [echo]
profiles: {}
tools:
  - type: cli_passthrough
    name: echo_tool
    description: "echo for tests"
    command: echo
    policy:
      allow_subcommands: [hello]
      deny_args_regex: ['^--token=']
`);
    const tool = cfg.tools[0];
    if (tool.type === 'cli_passthrough') {
      expect(tool.policy?.allow_subcommands).toEqual(['hello']);
      expect(tool.policy?.deny_args_regex).toEqual(['^--token=']);
    }
  });
});

describe('loadConfig', () => {
  it('reads and parses a YAML file', () => {
    const path = join(tmpdir(), `splicedock-test-${Date.now()}.yaml`);
    writeFileSync(path, MINIMAL_YAML);
    try {
      const cfg = loadConfig(path);
      expect(cfg.server.port).toBe(8788);
    } finally {
      unlinkSync(path);
    }
  });

  it('throws when file does not exist', () => {
    expect(() => loadConfig('/nonexistent/splicedock.yaml')).toThrow(/ENOENT/);
  });
});

describe('parseConfig — bare requirements on value-taking flags', () => {
  const kubectlTool = (requirement: string) => `
server:
  port: 8788
  admin_port: 8789
  admin_token_env: SPLICEDOCK_ADMIN_TOKEN
  cli_whitelist: [kubectl]
profiles: {}
tools:
  - type: cli_passthrough
    name: kube_tool
    description: "kubectl for tests"
    command: kubectl
    policy:
      require_args: ['${requirement}']
`;
  it('rejects a bare --namespace requirement, naming the tool and the flag', () => {
    expect(() => parseConfig(kubectlTool('--namespace'))).toThrow(
      /cli_passthrough 'kube_tool': policy\.require_args: bare requirement "--namespace"/,
    );
  });
  it('accepts the --namespace=<value> form', () => {
    expect(() => parseConfig(kubectlTool('--namespace=apps'))).not.toThrow();
  });
});
