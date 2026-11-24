import { describe, it, expect } from 'vitest';
import { executeCode } from '../../../src/services/code/mode/adapters/quickjs/executor.js';

const catalog = () => [{ name: 'test__get', description: 'Get data', inputSchema: { type: 'object' as const } }];
describe('Code Mode', () => {
  it('composes parallel calls and returns filtered data with trace', async () => {
    let active = 0, peak = 0;
    const response = await executeCode('const xs = await Promise.all(Array.from({length: 8}, (_, i) => tools.call("test__get", {i}))); return xs.map(x => x.structuredContent.i);', catalog, async (_name, args) => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { content: [], structuredContent: args };
    });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent?.result).toEqual([0,1,2,3,4,5,6,7]);
    expect(response.structuredContent?.calls).toHaveLength(8);
    expect(peak).toBe(4);
  });
  it('has no host globals and refuses recursion', async () => {
    const response = await executeCode('return [typeof process, typeof fetch, typeof require, typeof setTimeout];', catalog, async () => ({ content: [] }));
    expect(response.structuredContent?.result).toEqual(Array(4).fill('undefined'));
    expect((await executeCode('return await tools.call("code_mode__execute", {});', catalog, async () => ({ content: [] }))).isError).toBe(true);
  });
  it('preserves tool errors including approval responses', async () => {
    const response = await executeCode('return await tools.call("test__get", {});', catalog, async () => ({ content: [{ type: 'text', text: 'pending_approval' }], isError: true }));
    expect(response.structuredContent?.result).toMatchObject({ isError: true });
  });
  it('interrupts CPU loops when cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    expect((await executeCode('while(true) {}', catalog, async () => ({content: []}), controller.signal)).isError).toBe(true);
  });
});
