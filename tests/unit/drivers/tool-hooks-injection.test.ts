import { afterEach, describe, expect, it } from 'vitest';
import { configurePassthrough } from '../../../src/services/tools/adapters/cli/passthrough.js';
import type { ToolHooks } from '../../../src/services/tools/hooks.js';

afterEach(() => configurePassthrough({}));

describe('configurePassthrough', () => {
  it('accepts an empty hook set (every field optional)', () => {
    const hooks: ToolHooks = {};
    expect(() => configurePassthrough(hooks)).not.toThrow();
  });

  it('copies the hook object so later mutation of the input has no effect', () => {
    const hooks: { -readonly [K in keyof ToolHooks]: ToolHooks[K] } = {};
    expect(() => configurePassthrough(hooks)).not.toThrow();
    hooks.auditSink = () => { throw new Error('must not be used'); };
    expect(() => configurePassthrough({})).not.toThrow();
  });
});
