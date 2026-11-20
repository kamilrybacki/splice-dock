import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { executeWithPreflight, localPreflightServices } from '../../src/code-mode/preflight.js';
import type { ObservedRequest, ReplayPhase } from '../../src/code-mode/preflight.js';
import type { HttpExchange } from '../../src/adapters/outbound/drivers/http-wrapper.js';

const suite = [
  'identical', 'denied', 'review-error', 'observe', 'unsupported', 'mock-error',
  'url-divergence', 'body-divergence', 'new-call', 'repeated-call', 'cancelled',
  'redirect', 'oversize-response', 'oversize-trace', 'omitted-call', 'invalid-review',
] as const;
const request = 'await tools.call("demo__write", { value: "sample" });';
const repeat = Number(process.env.REPLAY_REPETITIONS ?? 1);
const cases = [];
for (let i = 0; i < repeat; i++) {
  for (const name of suite) {
    const sent: ObservedRequest[] = [];
    const reviewed: ObservedRequest[] = [];
    const controller = new AbortController();
    const listener = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      if (req.url === '/review') {
        reviewed.push(...JSON.parse(body).requests);
        if (name === 'cancelled') controller.abort();
        res.setHeader('content-type', 'application/json');
        res.writeHead(name === 'review-error' ? 503 : 200);
        return res.end(JSON.stringify({ decision: name === 'denied' ? 'deny' : name === 'invalid-review' ? true : 'allow' }));
      }
      if (req.url === '/mock') {
        res.setHeader('content-type', 'application/json');
        res.writeHead(name === 'mock-error' ? 503 : 200);
        return res.end(JSON.stringify({ status: 200, body: 'preview' }));
      }
      sent.push({ tool: 'demo__write', url: req.url ?? '', method: 'POST', body });
      if (name === 'redirect' && req.url === '/resource') return res.writeHead(307, { Location: '/other' }).end();
      res.end(name === 'oversize-response' ? 'x'.repeat(1024 * 1024 + 1) : 'live');
    });
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const code = name === 'new-call' || name === 'repeated-call'
        ? 'const r = await tools.call("demo__write", {}); if(r.content[0].text === "live") ' +
          (name === 'new-call' ? 'await tools.call("demo__write", { value: "extra" });' : 'await tools.call("demo__write", {});')
        : name === 'omitted-call'
          ? 'const r = await tools.call("demo__write", {}); if(r.content[0].text === "preview") await tools.call("demo__write", {});'
          : request;
      async function dispatch(tool: string, args: Record<string, unknown>, phase: ReplayPhase, exchange: HttpExchange) {
        if (name === 'unsupported') return { content: [], isError: true };
        const target = phase === 'live' && name === 'url-divergence' ? '/other' : '/resource';
        const body = name === 'oversize-trace' ? 'x'.repeat(17 * 1024)
          : JSON.stringify(phase === 'live' && name === 'body-divergence' ? { value: 'changed' } : args);
        const observed = { tool, url: base + target, method: 'POST' as const, body };
        const response = await exchange(observed, signal => fetch(observed.url, {
          method: observed.method, body, redirect: 'error', signal,
        }));
        return { content: [{ type: 'text' as const, text: await response.text() }], isError: !response.ok };
      }
      const result = await executeWithPreflight({
        code, profile: 'test', catalog: () => [], dispatch,
        services: localPreflightServices(base + '/mock', base + '/review'),
        allowLive: name !== 'observe', signal: controller.signal,
      });
      assert.equal(!!result.isError, name !== 'identical', name);
      const shouldSend = ['identical', 'new-call', 'repeated-call', 'redirect', 'oversize-response', 'omitted-call'].includes(name);
      assert.equal(sent.length, shouldSend ? 1 : 0, name);
      if (shouldSend) {
        assert.equal(sent[0].url, '/resource', name);
        assert.equal(sent[0].body, reviewed[0].body, name);
      }
      cases.push({ name, iteration: i, requestsSent: sent.length });
    } finally {
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
  }
}
console.log(JSON.stringify({ passed: cases.length, scenarios: suite.length, cases }));
