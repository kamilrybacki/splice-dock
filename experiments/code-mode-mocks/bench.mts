import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { executeCode } from '../../src/code-mode/executor.js';

type Scenario = 'missing' | 'exists' | 'upstream-error';
type Fixture = { summary: string };
type FixtureProvider = (input: { scenario: Scenario; seed: number }) => Promise<Fixture>;

const workflow = `
const found = await tools.call("demo__find", { title: "Nightly report" });
if (found.isError) return { status: "upstream-error" };
const existing = found.structuredContent.ticket;
const ticket = existing ?? (await tools.call("demo__create", {
  title: "Nightly report", summary: found.structuredContent.summary
})).structuredContent;
const read = (await tools.call("demo__read", { id: ticket.id })).structuredContent;
return { status: existing ? "exists" : "created", id: read.id, summary: read.summary };
`;

const bounded = process.env.MOCK_BENCH_BOUNDED === '1';

const template: FixtureProvider = async ({ seed }) => ({
  summary: `Nightly demo batch ${seed} completed its sample checks.`,
});

// All providers return only descriptive fixture fields. HTTP behavior belongs to the simulator.
function chatProvider(port: number, model: string): FixtureProvider {
  return async ({ scenario, seed }) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model, seed, temperature: 0.3, max_tokens: 80,
        messages: [
          { role: 'system', content: 'Generate a fake status summary in English. Return a JSON object with one string field, summary.' },
          { role: 'user', content: `Nightly test report, batch ${seed}, scenario ${scenario}. Write one short sentence about sample checks.` },
        ],
        response_format: { type: 'json_schema', json_schema: {
          name: 'fixture', strict: true,
          schema: { type: 'object', additionalProperties: false,
            properties: { summary: { type: 'string', ...(bounded ? { minLength: 1, maxLength: 120 } : {}) } }, required: ['summary'] },
        } },
      }),
    });
    if (!res.ok) throw Error(`fixture endpoint HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
    const payload = await res.json();
    const fixture = JSON.parse(payload.choices[0].message.content);
    assert.deepEqual(Object.keys(fixture), ['summary']);
    assert(typeof fixture.summary === 'string' && fixture.summary.trim() && fixture.summary.length <= (bounded ? 120 : 220));
    return { summary: fixture.summary };
  };
}

async function run(scenario: Scenario, fixture: Fixture) {
  type Ticket = { id: number; title: string; summary: string };
  let ticket: Ticket | null = scenario === 'exists'
    ? { id: 41, title: 'Nightly report', summary: fixture.summary } : null;
  const observed: { method: string; path: string; body: unknown; status: number }[] = [];
  const server = createServer(async (req, res) => {
    const method = req.method ?? '';
    const path = req.url ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    let status = 404;
    let data: unknown = { message: 'Unknown demo route' };
    if (method === 'GET' && path === '/demo/tickets?title=Nightly+report') {
      status = scenario === 'upstream-error' ? 503 : 200;
      data = status === 503 ? { message: fixture.summary } : { ticket, summary: fixture.summary };
    } else if (method === 'POST' && path === '/demo/tickets' && !ticket) {
      const input = body as Omit<Ticket, 'id'>;
      ticket = { id: 842, title: input.title, summary: input.summary };
      status = 201;
      data = ticket;
    } else if (method === 'GET' && ticket && path === `/demo/tickets/${ticket.id}`) {
      status = 200;
      data = ticket;
    }
    observed.push({ method, path, body, status });
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const result = await executeCode(workflow, () => [], async (name, args) => {
      const method = name === 'demo__create' ? 'POST' : 'GET';
      const url = name === 'demo__find'
        ? '/demo/tickets?' + new URLSearchParams({ title: String(args.title) })
        : name === 'demo__read' && Number.isSafeInteger(args.id) ? `/demo/tickets/${args.id}`
        : name === 'demo__create' ? '/demo/tickets' : null;
      if (!url) throw Error('Unknown demo tool');
      const response = await fetch(base + url, {
        method, redirect: 'error',
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) } : {}),
      });
      return { content: [], structuredContent: await response.json(), isError: !response.ok };
    });
    const expected = scenario === 'missing' ? [['GET', 200], ['POST', 201], ['GET', 200]]
      : scenario === 'exists' ? [['GET', 200], ['GET', 200]] : [['GET', 503]];
    assert.deepEqual(observed.map(x => [x.method, x.status]), expected);
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent?.result, scenario === 'upstream-error'
      ? { status: scenario } : { status: scenario === 'missing' ? 'created' : 'exists',
        id: scenario === 'missing' ? 842 : 41, summary: fixture.summary });
    if (scenario === 'missing') {
      assert.deepEqual(observed[1].body, { title: 'Nightly report', summary: fixture.summary });
      assert.equal(observed[2].path, '/demo/tickets/842');
    }
    return observed;
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const trials: object[] = [];
const providers = { template, smol: chatProvider(18951, 'smol'), qwen: chatProvider(18952, 'qwen') };
for (const [provider, generate] of Object.entries(providers)) {
  for (let seed = 1; seed <= 6; seed++) {
    for (const scenario of ['missing', 'exists', 'upstream-error'] as const) {
      const started = performance.now();
      let generationMs: number | undefined;
      try {
        const fixture = await generate({ scenario, seed });
        generationMs = Math.round(performance.now() - started);
        const requests = await run(scenario, fixture);
        trials.push({ provider, scenario, seed, generationMs, ms: Math.round(performance.now() - started), fixture, requests, ok: true });
      } catch (error) {
        trials.push({ provider, scenario, seed, generationMs, ms: Math.round(performance.now() - started), error: String(error), ok: false });
      }
    }
  }
}
writeFileSync(new URL(bounded ? './results-bounded.json' : './results.json', import.meta.url), JSON.stringify({ workflow, bounded, trials }, null, 2) + '\n');
console.log(JSON.stringify(trials.map(({provider, scenario, seed, ms, ok, error}: { provider?: string; scenario?: string; seed?: number; ms?: number; ok?: boolean; error?: string }) => ({provider, scenario, seed, ms, ok, error}))));
