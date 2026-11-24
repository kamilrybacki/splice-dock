import type { HttpToolConfig } from '../../../config/types.js';

/** The outbound request an HTTP tool is about to make. */
export type HttpRequest = { url: string; method: HttpToolConfig['method']; body?: string };

/**
 * Wraps the actual network send. Code mode uses it to pre-flight, record or
 * replay a request; the default exchange just calls `send`.
 */
export type HttpExchange = (
  request: HttpRequest,
  send: (signal: AbortSignal) => Promise<Response>,
) => Promise<Response>;
