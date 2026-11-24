import { describe, it, expect } from 'vitest';
import {
  compilePolicy,
  evaluatePolicy,
  PolicyCompileError,
  type CompiledCliPolicy,
} from '../../../src/services/policy/cli-policy.js';
import type { CliToolPolicy } from '../../../src/config/types.js';

function mkPolicy(overrides: Partial<CliToolPolicy> = {}): CliToolPolicy {
  return {
    max_args: 256,
    on_violation: 'deny',
    audit: false,
    ...overrides,
  };
}

describe('compilePolicy', () => {
  it('returns a permissive default for undefined input', () => {
    const c = compilePolicy(undefined);
    expect(c.maxArgs).toBe(256);
    expect(c.audit).toBe(false);
    expect(c.allowSubcommands).toBeUndefined();
    expect(c.denySubcommands).toBeUndefined();
  });

  it('rejects allow_subcommands + deny_subcommands together', () => {
    expect(() =>
      compilePolicy(mkPolicy({ allow_subcommands: ['get'], deny_subcommands: ['delete'] })),
    ).toThrow(PolicyCompileError);
  });

  it('rejects allow_subcommand_paths + deny_subcommand_paths together', () => {
    expect(() =>
      compilePolicy(
        mkPolicy({
          allow_subcommand_paths: [['app', 'get']],
          deny_subcommand_paths: [['repo', 'delete']],
        }),
      ),
    ).toThrow(PolicyCompileError);
  });

  it('rejects invalid regex strings at compile time', () => {
    expect(() => compilePolicy(mkPolicy({ deny_args_regex: ['[unclosed'] }))).toThrow(
      PolicyCompileError,
    );
  });

  it('compiles valid regexes', () => {
    const c = compilePolicy(mkPolicy({ deny_args_regex: ['^--token='] }));
    expect(c.denyArgsRegex).toHaveLength(1);
    expect(c.denyArgsRegex![0].source).toBe('^--token=');
  });

  it('treats empty arrays as undefined (permissive)', () => {
    const c = compilePolicy(
      mkPolicy({ deny_subcommands: [], allow_subcommands: [], deny_args: [] }),
    );
    expect(c.denySubcommands).toBeUndefined();
    expect(c.allowSubcommands).toBeUndefined();
    expect(c.denyArgs).toBeUndefined();
  });
});

describe('evaluatePolicy — max_args', () => {
  it('denies argv longer than max_args', () => {
    const c = compilePolicy(mkPolicy({ max_args: 3 }));
    const d = evaluatePolicy(['a', 'b', 'c', 'd'], c);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.rule).toBe('max_args');
  });

  it('allows argv at exactly max_args', () => {
    const c = compilePolicy(mkPolicy({ max_args: 3 }));
    expect(evaluatePolicy(['a', 'b', 'c'], c).ok).toBe(true);
  });
});

describe('evaluatePolicy — deny_subcommands', () => {
  it('denies when first non-flag token matches', () => {
    const c = compilePolicy(mkPolicy({ deny_subcommands: ['delete', 'edit'] }));
    const d = evaluatePolicy(['delete', 'pod', 'x'], c);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.rule).toBe('deny_subcommands');
      expect(d.matched).toBe('delete');
    }
  });

  it('allows when first non-flag token is not in the list', () => {
    const c = compilePolicy(mkPolicy({ deny_subcommands: ['delete'] }));
    expect(evaluatePolicy(['get', 'pods'], c).ok).toBe(true);
  });

  it('skips leading flags when finding the subcommand', () => {
    const c = compilePolicy(mkPolicy({ deny_subcommands: ['delete'] }));
    // `kubectl --kubeconfig=/x delete pods` → first non-flag is 'delete'
    expect(evaluatePolicy(['--kubeconfig=/x', 'delete', 'pods'], c).ok).toBe(false);
  });
});

describe('evaluatePolicy — deny_subcommand_paths', () => {
  it('denies a multi-token prefix match', () => {
    const c = compilePolicy(mkPolicy({ deny_subcommand_paths: [['repo', 'delete']] }));
    const d = evaluatePolicy(['repo', 'delete', 'foo'], c);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.rule).toBe('deny_subcommand_paths');
  });

  it('allows a path that does not match the prefix', () => {
    const c = compilePolicy(mkPolicy({ deny_subcommand_paths: [['repo', 'delete']] }));
    expect(evaluatePolicy(['repo', 'view', 'foo'], c).ok).toBe(true);
  });

  it('consumes long-flag value pairs (--foo bar) when matching paths', () => {
    // `gh release --repo foo delete v1` — long flag with a separate value.
    // The extractor must swallow `--repo` AND its value `foo` so the path
    // matches `['release', 'delete']`.
    const c = compilePolicy(mkPolicy({ deny_subcommand_paths: [['release', 'delete']] }));
    expect(evaluatePolicy(['release', '--repo', 'foo', 'delete', 'v1'], c).ok).toBe(false);
  });

  it('skips long flags with =value form (--foo=bar)', () => {
    const c = compilePolicy(mkPolicy({ deny_subcommand_paths: [['release', 'delete']] }));
    expect(evaluatePolicy(['release', '--repo=foo', 'delete', 'v1'], c).ok).toBe(false);
  });

  it('matches when flag-values are absent', () => {
    const c = compilePolicy(mkPolicy({ deny_subcommand_paths: [['release', 'delete']] }));
    expect(evaluatePolicy(['release', 'delete', 'v1', '--repo', 'x'], c).ok).toBe(false);
  });
});

describe('evaluatePolicy — deny_args / deny_args_regex / deny_argv_regex', () => {
  it('denies on substring match in any argv element', () => {
    const c = compilePolicy(mkPolicy({ deny_args: ['--token'] }));
    const d = evaluatePolicy(['get', '--token=abc', 'pods'], c);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.rule).toBe('deny_args');
  });

  it('denies on per-element regex match', () => {
    const c = compilePolicy(mkPolicy({ deny_args_regex: ['^--as='] }));
    expect(evaluatePolicy(['--as=root', 'get', 'pods'], c).ok).toBe(false);
  });

  it('denies on joined-argv regex match', () => {
    const c = compilePolicy(mkPolicy({ deny_argv_regex: ['\\bDROP\\s+TABLE\\b'] }));
    expect(evaluatePolicy(['-c', 'DROP TABLE users'], c).ok).toBe(false);
  });
});

describe('evaluatePolicy — allow_subcommands / allow_subcommand_paths', () => {
  it('denies when subcommand is not in allow list', () => {
    const c = compilePolicy(mkPolicy({ allow_subcommands: ['get', 'describe'] }));
    const d = evaluatePolicy(['delete', 'pod', 'x'], c);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.rule).toBe('allow_subcommands');
  });

  it('denies an empty argv against an allow list', () => {
    const c = compilePolicy(mkPolicy({ allow_subcommands: ['get'] }));
    expect(evaluatePolicy([], c).ok).toBe(false);
  });

  it('allows a subcommand that matches', () => {
    const c = compilePolicy(mkPolicy({ allow_subcommands: ['get'] }));
    expect(evaluatePolicy(['get', 'pods'], c).ok).toBe(true);
  });

  it('denies when path is not in allow_subcommand_paths', () => {
    const c = compilePolicy(
      mkPolicy({ allow_subcommand_paths: [['app', 'get'], ['app', 'sync']] }),
    );
    const d = evaluatePolicy(['app', 'delete', 'x'], c);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.rule).toBe('allow_subcommand_paths');
  });

  it('allows a path that prefix-matches one entry', () => {
    const c = compilePolicy(mkPolicy({ allow_subcommand_paths: [['app', 'get']] }));
    expect(evaluatePolicy(['app', 'get', 'argocd'], c).ok).toBe(true);
  });
});

describe('evaluatePolicy — require_args / require_any_of', () => {
  it('denies when a required arg is missing', () => {
    const c = compilePolicy(mkPolicy({ require_args: ['--namespace=sentinel'] }));
    expect(evaluatePolicy(['get', 'pods'], c).ok).toBe(false);
  });

  it('allows when all required args are present (separate value)', () => {
    const c = compilePolicy(mkPolicy({ require_args: ['--namespace=sentinel'] }));
    expect(evaluatePolicy(['get', 'pods', '--namespace', 'sentinel'], c).ok).toBe(true);
  });

  it('allows when required arg is in --flag=value form (no bypass via = syntax)', () => {
    const c = compilePolicy(mkPolicy({ require_args: ['--namespace=sentinel'] }));
    expect(evaluatePolicy(['get', 'pods', '--namespace=sentinel'], c).ok).toBe(true);
  });

  it('require_any_of: denies when none of the alternatives appear', () => {
    const c = compilePolicy(mkPolicy({ require_any_of: [['-n=sentinel', '--namespace=sentinel']] }));
    expect(evaluatePolicy(['get', 'pods'], c).ok).toBe(false);
  });

  it('require_any_of: allows when one alternative appears (separate value)', () => {
    const c = compilePolicy(mkPolicy({ require_any_of: [['-n=sentinel', '--namespace=sentinel']] }));
    expect(evaluatePolicy(['get', 'pods', '-n', 'sentinel'], c).ok).toBe(true);
  });

  it('require_any_of: allows when one alternative appears as flag=value form', () => {
    const c = compilePolicy(mkPolicy({ require_any_of: [['-n=sentinel', '--namespace=sentinel']] }));
    expect(evaluatePolicy(['get', 'pods', '--namespace=sentinel'], c).ok).toBe(true);
  });
});

describe('evaluatePolicy — rule ordering', () => {
  it('max_args runs before everything else', () => {
    const c = compilePolicy(mkPolicy({ max_args: 1, allow_subcommands: ['get'] }));
    const d = evaluatePolicy(['get', 'pods'], c);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.rule).toBe('max_args');
  });

  it('deny rules win over allow rules', () => {
    const c = compilePolicy(
      mkPolicy({ allow_subcommands: ['get'], deny_args: ['--token'] }),
    );
    const d = evaluatePolicy(['get', '--token=x'], c);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.rule).toBe('deny_args');
  });
});

describe('evaluatePolicy — error message redaction', () => {
  it('replaces the value half of long flag=value with ***', () => {
    const c = compilePolicy(mkPolicy({ deny_args: ['--token'] }));
    const d = evaluatePolicy(['get', '--token=hunter2-very-long-secret'], c);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.message).toContain('***');
      expect(d.message).not.toContain('hunter2-very-long-secret');
    }
  });

  it('keeps short tokens visible (no redaction needed)', () => {
    const c = compilePolicy(mkPolicy({ deny_args: ['x'] }));
    const d = evaluatePolicy(['x'], c);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.message).toContain('"x"');
    }
  });
});

describe('policyFor double-set guard (via wrapper)', () => {
  // Integration here via the wrapper module to avoid duplicating the guard.
  it('legacy + policy.deny_subcommands both set throws via wrapper compile', async () => {
    const { callCliPassthrough } = await import('../../../src/services/tools/adapters/cli/passthrough.js');
    const result = await callCliPassthrough(
      {
        type: 'cli_passthrough',
        name: 'broken',
        description: 'broken',
        command: 'echo',
        deny_subcommands: ['delete'],
        env: [],
        timeout_ms: 5000,
        policy: {
          deny_subcommands: ['edit'],
          max_args: 256,
          on_violation: 'deny' as const,
          audit: false,
        },
      },
      'run',
      { args: ['get'] },
      ['echo'],
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('deny_subcommands');
    expect(result.content[0].text).toContain('both');
  });
});

describe('audit flag passthrough', () => {
  it('forwards audit:true into the compiled policy', () => {
    const c: CompiledCliPolicy = compilePolicy(mkPolicy({ audit: true }));
    expect(c.audit).toBe(true);
  });
});
