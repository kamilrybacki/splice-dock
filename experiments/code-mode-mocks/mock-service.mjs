// Reference mock sidecar for the benchmark's fictional ticket API.
// It never forwards to the origin contained in a captured request.
import { createServer } from 'node:http';

const template = 'Nightly demo checks completed.';
const sessions = new Map();
const modelId = process.env.MOCK_MODEL_ID;
const modelPort = Number(process.env.MOCK_MODEL_PORT ?? 18952);

async function summarize() {
  if (!modelId) return template;
  try {
    const response = await fetch(`http://127.0.0.1:${modelPort}/v1/chat/completions`, {
      method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(2500),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Generate one short fictional sentence about a nightly test report. Respond as JSON with a summary field.' }],
        max_tokens: 80,
        response_format: { type: 'json_schema', json_schema: { name: 'fixture', strict: true, schema: {
          type: 'object', properties: { summary: { type: 'string', minLength: 1, maxLength: 120 } },
          required: ['summary'], additionalProperties: false,
        } } },
      }),
    });
    if (!response.ok) return template;
    const payload = await response.json();
    const { summary } = JSON.parse(payload.choices[0].message.content);
    return typeof summary === 'string' && summary.trim() && summary.length <= 120 ? summary : template;
  } catch {
    return template;
  }
}

function session(runId) {
  const now = Date.now();
  for (const [key, value] of sessions) if (now >= value.expires) sessions.delete(key);
  const existing = sessions.get(runId);
  if (existing) return existing;
  if (sessions.size >= 128) throw Error('Mock capacity reached');
  const created = { expires: now + 70_000, summary: summarize(), ticket: null };
  sessions.set(runId, created);
  return created;
}

async function mock({ request, runId }) {
  if (!request || typeof runId !== 'string' || !/^[0-9a-f-]{36}$/.test(runId)) throw Error('Invalid request');
  const url = new URL(request.url);
  if (url.pathname === '/demo/tickets' && request.method === 'GET') {
    const state = session(runId);
    return [200, { ticket: state.ticket, summary: await state.summary }];
  }
  if (url.pathname === '/demo/tickets' && request.method === 'POST') {
    const state = session(runId);
    const data = JSON.parse(request.body);
    if (typeof data.title !== 'string' || typeof data.summary !== 'string') throw Error('Invalid fictional ticket');
    if (state.ticket) return [409, { message: 'Ticket already exists' }];
    state.ticket = { id: 842, title: data.title, summary: data.summary };
    return [201, state.ticket];
  }
  if (url.pathname === '/demo/tickets/842' && request.method === 'GET') {
    const ticket = sessions.get(runId)?.ticket;
    return ticket ? [200, ticket] : [404, { message: 'Ticket not found' }];
  }
  throw Error('Unsupported route');
}

// Explicit fixtures for sample tool names. The sidecar never spawns a process
// or opens an MCP connection to produce these responses.
function mockOperation(request) {
  const isCliDemo = request.driver === 'cli' && request.tool === 'demo__echo';
  const isPassthroughDemo = request.driver === 'cli_passthrough' && request.tool === 'demo__help';
  const isMcpDemo = request.driver === 'mcp_proxy' && request.tool === 'demo__read' &&
    request.method === 'tools/call' && request.params?.name === 'read';
  if (!isCliDemo && !isPassthroughDemo && !isMcpDemo) throw Error('Unsupported demo operation');
  return { content: [{ type: 'text', text: 'Synthetic demonstration result' }] };
}

export function startMockService(port = 18953) {
  return createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST') return res.writeHead(405).end('{}');
    // The reference guard rejects real forwarding. An operator must supply a separate reviewer for enforce.
    if (req.url === '/review') return res.end('{"decision":"deny"}');
    if (req.url !== '/mock') return res.writeHead(404).end('{}');
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32 * 1024) return res.writeHead(413).end('{}');
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (data.request?.driver) return res.end(JSON.stringify({ result: mockOperation(data.request) }));
      const [status, body] = await mock(data);
      return res.end(JSON.stringify({ status, body: JSON.stringify(body) }));
    } catch {
      return res.writeHead(422).end('{}');
    }
  }).listen(port, '127.0.0.1');
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) startMockService();
