import { CallToolResultSchema, type CompatibilityCallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HttpExchange, HttpRequest } from '../../ports/http-exchange.js';
import type { McpToolDef } from '../registry/tool-registry.js';
import type { ObservedOperation, OperationExchange } from '../../ports/operation-exchange.js';
import { executeCode } from './executor.js';

type Result = CompatibilityCallToolResult;
export type ObservedRequest = HttpRequest & { tool: string };
type TraceEntry = ObservedRequest | (ObservedOperation & { tool: string });
export type ReplayPhase = 'preview' | 'live';
export type PreflightServices = {
  mock(request: ObservedRequest, runId: string, signal: AbortSignal): Promise<Response>;
  mockOperation?(request: ObservedOperation & { tool: string }, runId: string, signal: AbortSignal): Promise<Result>;
  review(input: { code: string; profile: string; requests: readonly TraceEntry[] }, signal: AbortSignal): Promise<boolean>;
};
type Options = {
  code: string;
  profile: string;
  catalog: () => McpToolDef[];
  dispatch(name: string, args: Record<string, unknown>, phase: ReplayPhase, exchange: HttpExchange, signal: AbortSignal, operation: OperationExchange): Promise<Result>;
  services: PreflightServices;
  signal?: AbortSignal;
  // Required for the real phase. Profile names/tools come from the host, not the snippet.
  allowLive: boolean;
};

const refused = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });
const requestLimit = 16 * 1024;
const traceLimit = 64 * 1024;

export async function executeWithPreflight(options: Options): Promise<Result> {
  const { code, profile, catalog, dispatch, services } = options;
  const signal = AbortSignal.any([
    AbortSignal.timeout(65_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const runId = crypto.randomUUID();
  const requests: TraceEntry[] = [];
  let size = 0;
  let violated = false;
  let liveToolError: Result | undefined;

  const execute = (phase: ReplayPhase, exchange: (tool: string) => HttpExchange, operate: (tool: string) => OperationExchange) => {
    const phaseSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    return executeCode(code, catalog, async (tool, args) => {
      let intercepted = false;
      try {
        const result = await dispatch(tool, args, phase, async (request, send) => {
          phaseSignal.throwIfAborted();
          intercepted = true;
          return exchange(tool)(request, send);
        }, phaseSignal, async (operation, invoke) => {
          phaseSignal.throwIfAborted();
          intercepted = true;
          return operate(tool)(operation, invoke);
        });
        if (!intercepted) violated = true;
        if (phase === 'live' && result.isError) {
          violated = true;
          liveToolError ??= result;
        }
        return result;
      } catch {
        violated = true;
        return refused('Code Mode operation stopped');
      }
    }, phaseSignal);
  };

  const record = (observed: TraceEntry) => {
    if (violated) throw Error('Simulation stopped');
    const bytes = Buffer.byteLength(JSON.stringify(observed));
    size += bytes;
    if (bytes > requestLimit || size > traceLimit) throw Error('Simulation trace limit exceeded');
    requests.push(observed);
  };

  const simulated = await execute('preview', tool => async request => {
    const observed = { tool, ...request };
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw Error('Unsupported HTTP target');
    }
    record(observed);
    return boundedResponse(await services.mock(observed, runId, AbortSignal.any([signal, AbortSignal.timeout(5000)])));
  }, tool => async operation => {
    const observed = { tool, ...operation };
    record(observed);
    if (!services.mockOperation) throw Error('Operation simulator unavailable');
    return services.mockOperation(observed, runId, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
  });
  if (violated || simulated.isError || signal.aborted) return refused('Code Mode simulation incomplete; nothing sent upstream');
  if (!requests.length) return simulated;

  try {
    const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    if (!await services.review({ code, profile, requests }, reviewSignal) || reviewSignal.aborted) {
      return refused('Code Mode review did not authorize the trace; nothing sent upstream');
    }
  } catch {
    return refused('Code Mode review unavailable; nothing sent upstream');
  }
  if (!options.allowLive) return refused('Code Mode preflight is in simulation-only mode; nothing sent upstream');

  let index = 0;
  const consume = (operation: TraceEntry) => {
    if (violated || JSON.stringify(requests[index]) !== JSON.stringify(operation)) {
      violated = true;
      throw Error('Actual operation differs from reviewed trace');
    }
    signal.throwIfAborted();
    index++;
  };
  const actual = await execute('live', tool => async (request, send) => {
    consume({ tool, ...request });
    return boundedResponse(await send(AbortSignal.any([signal, AbortSignal.timeout(5000)])));
  }, tool => async (operation, invoke) => {
    consume({ tool, ...operation });
    return invoke();
  });
  if (violated || actual.isError || index !== requests.length) {
    return liveToolError ?? refused('Code Mode replay stopped; earlier requests may already have completed');
  }
  return actual;
}

// Limit both mocked and real response reads. Refuse instead of allocating unbounded data.
async function boundedResponse(response: Response): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        void reader.cancel().catch(() => {});
        throw Error('HTTP response exceeds preflight byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks), { status: response.status });
}

async function invoke(endpoint: string, input: unknown, signal: AbortSignal): Promise<Response> {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.hash) throw Error('Preflight endpoint must be a local sidecar');
  const response = await boundedResponse(await fetch(url, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }));
  if (!response.ok) throw Error('Preflight sidecar rejected request');
  return response;
}

export function localPreflightServices(mockUrl: string, reviewUrl: string): PreflightServices {
  return {
    async mock(request, runId, signal) {
      const data: unknown = await (await invoke(mockUrl, { request, runId }, signal)).json();
      if (!data || typeof data !== 'object' || !('status' in data) || !('body' in data) ||
          typeof data.status !== 'number' || !Number.isInteger(data.status) ||
          data.status < 200 || data.status > 599 || typeof data.body !== 'string') {
        throw Error('Invalid mock response');
      }
      return new Response([204, 205, 304].includes(data.status) ? null : data.body, { status: data.status });
    },
    async mockOperation(request, runId, signal) {
      const envelope = await (await invoke(mockUrl, { request, runId }, signal)).json();
      return CallToolResultSchema.parse(envelope.result);
    },
    async review(input, signal) {
      const data: unknown = await (await invoke(reviewUrl, input, signal)).json();
      return !!data && typeof data === 'object' && 'decision' in data && data.decision === 'allow';
    },
  };
}
