import { describe, it, expect } from 'vitest';
import { callCliTool } from '../../../src/services/tools/adapters/cli/static.js';
import type { CliToolConfig } from '../../../src/config/types.js';

function makeConfig(overrides: Partial<CliToolConfig> = {}): CliToolConfig {
  return {
    type: 'cli',
    name: 'test_cmd',
    namespace: 'test',
    description: 'Test CLI tool',
    command: 'echo',
    args: ['hello'],
    params: [],
    timeout_ms: 5000,
    env: [],
    auth: 'none',
    ...overrides,
  };
}

describe('callCliTool', () => {
  it('runs a whitelisted command and returns stdout', async () => {
    const result = await callCliTool(makeConfig({ args: ['hello world'] }), {}, ['echo']);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.trim()).toBe('hello world');
  });

  it('rejects a non-whitelisted command', async () => {
    const result = await callCliTool(makeConfig({ command: 'rm' }), {}, ['echo', 'ls']);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not in whitelist");
  });

  it('returns isError on non-zero exit code', async () => {
    const result = await callCliTool(
      makeConfig({ command: 'sh', args: ['-c', 'exit 1'] }),
      {},
      ['sh'],
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Exit 1');
  });

  it('substitutes args from input parameters', async () => {
    const config = makeConfig({
      command: 'echo',
      args: ['{message}'],
      params: [{ name: 'message', in: 'query', required: true }],
    });
    const result = await callCliTool(config, { message: 'hello' }, ['echo']);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.trim()).toBe('hello');
  });

  it('prevents shell injection — semicolons in args are literal, not executed', async () => {
    const config = makeConfig({
      command: 'echo',
      args: ['{input}'],
      params: [{ name: 'input', in: 'query', required: true }],
    });
    // The injected content should appear literally in the output, not be executed
    const result = await callCliTool(config, { input: 'safe; echo INJECTED' }, ['echo']);
    expect(result.isError).toBeUndefined();
    // Since shell=false, the entire string including semicolons is passed as a single arg
    const text = result.content[0].text;
    // The output should contain the literal string — not execute the injected command
    expect(text).toContain('safe');
    // It should NOT produce a separate 'INJECTED' line from shell execution
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('only exposes declared env vars to the process', async () => {
    process.env.ALLOWED_VAR = 'allowed-value';
    process.env.SECRET_VAR = 'should-not-appear';

    const config = makeConfig({
      command: 'sh',
      args: ['-c', 'echo "${ALLOWED_VAR:-not-set}:${SECRET_VAR:-not-set}"'],
      env: ['ALLOWED_VAR'],
    });
    const result = await callCliTool(config, {}, ['sh']);
    // ALLOWED_VAR should be available, SECRET_VAR should not
    expect(result.content[0].text.trim()).toBe('allowed-value:not-set');

    delete process.env.ALLOWED_VAR;
    delete process.env.SECRET_VAR;
  });

  it('returns isError on timeout', async () => {
    const config = makeConfig({
      command: 'sh',
      args: ['-c', 'sleep 10'],
      timeout_ms: 100,
    });
    const result = await callCliTool(config, {}, ['sh']);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timed out');
  });

  it('uses default param value when arg not provided', async () => {
    const config = makeConfig({
      command: 'echo',
      args: ['{greeting}'],
      params: [{ name: 'greeting', in: 'query', required: false, default: 'hi there' }],
    });
    const result = await callCliTool(config, {}, ['echo']);
    expect(result.content[0].text.trim()).toBe('hi there');
  });
});
