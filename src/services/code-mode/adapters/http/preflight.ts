import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { boundedResponse, type PreflightServices } from '../../preflight.js';

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
