import { expect, it, vi } from 'vitest';
import { callCliPassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { CliPassthroughToolConfig } from '../../../src/config/types.js';
it('refuses spawn rather than using a previously injected credential', async () => {
  vi.stubEnv('T8_STALE', 'stale-test-fixture');
  const config: CliPassthroughToolConfig = {
    type: 'cli_passthrough', name: 'test', command: '/bin/echo', description: 'test',
    env: [{ name: 'T8_STALE', from: 'env:T8_MISSING' }], deny_subcommands: [], timeout_ms: 1000,
    policy: { max_args: 64, on_violation: 'deny', audit: false },
  };
  try {
    const result = await callCliPassthrough(config, 'run', { args: ['must-not-execute'] }, ['/bin/echo']);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('vault_unavailable');
    expect(JSON.stringify(result)).not.toContain('stale-test-fixture');
  } finally { vi.unstubAllEnvs(); }
});
