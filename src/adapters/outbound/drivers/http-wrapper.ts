import { resolveAuthValue } from '../../../application/auth/resolver.js';
import { resolveCredentialSource } from '../../../application/credentials/broker.js';
import { currentCaller } from '../../../common/request-context.js';
import type { HttpToolConfig } from '../../../config/types.js';
import { retry } from './shared.js';
import type { McpCallResult } from './shared.js';
export type { McpCallResult } from './shared.js';

import type { HttpExchange, HttpRequest } from '../../../ports/http-exchange.js';
export type { HttpExchange, HttpRequest } from '../../../ports/http-exchange.js';

export async function callHttpTool(
  config: HttpToolConfig,
  args: Record<string, string>,
  exchange?: HttpExchange,
): Promise<McpCallResult> {
  const body = buildBody(config.params ?? [], args);
  if ('error' in body) {
    return { content: [{ type: 'text', text: body.error }], isError: true };
  }
  const hasBody = Object.keys(body.params).length > 0 && !['GET', 'DELETE'].includes(config.method);
  const request: HttpRequest = {
    url: buildUrl(config.url, args, config.params),
    method: config.method,
    ...(hasBody ? { body: JSON.stringify(body.params) } : {}),
  };
  const send = async (signal: AbortSignal) => {
    const headers = await buildHeaders(config);
    signal.throwIfAborted();
    return fetch(request.url, {
      method: request.method, headers, body: request.body, signal,
      ...(exchange ? { redirect: 'error' as const } : {}),
    });
  };
  const attempt = async () => {
    const response = exchange
      ? await exchange(request, send)
      : await send(AbortSignal.timeout(config.timeout_ms ?? 30_000));
    const text = await response.text();
    if (!response.ok) {
      const safeText = text.slice(0, 512).replace(/[^\x20-\x7E\n]/g, '');
      return { content: [{ type: 'text' as const, text: `HTTP ${response.status}: ${safeText}` }], isError: true };
    }
    return { content: [{ type: 'text' as const, text }] };
  };
  // One approved entry grants one send. Automatic retries would spend it again.
  return exchange ? attempt() : retry(config.retry?.max_attempts ?? 1, config.retry?.backoff_ms ?? 500, attempt);
}

type BodyResult = { params: Record<string, unknown> } | { error: string };

function buildBody(params: HttpToolConfig['params'], args: Record<string, string>): BodyResult {
  const out: Record<string, unknown> = {};
  for (const param of params) {
    if (param.in !== 'body') continue;
    const value = args[param.name] ?? param.default;
    if (param.format !== 'json') {
      out[param.name] = value ?? '';
      continue;
    }
    if (value === undefined || value === '') {
      if (param.required) return { error: `Missing required JSON parameter '${param.name}'` };
      continue;
    }
    try {
      out[param.name] = JSON.parse(value);
    } catch {
      return { error: `Parameter '${param.name}' must be valid JSON` };
    }
  }
  return { params: out };
}

function buildUrl(template: string, args: Record<string, string>, params: HttpToolConfig['params']): string {
  let url = template;
  const queryParams: string[] = [];
  for (const param of params) {
    const value = args[param.name] ?? param.default ?? '';
    if (param.in === 'path') {
      url = url.replace(`{${param.name}}`, encodeURIComponent(value));
    } else if (param.in === 'query' && (args[param.name] || param.default)) {
      queryParams.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(value)}`);
    }
  }
  return queryParams.length ? `${url}?${queryParams.join('&')}` : url;
}

async function buildHeaders(config: HttpToolConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.auth.type === 'none') return headers;
  const caller = currentCaller();
  const target = { profile: caller?.profile ?? '', agent: caller?.agent ?? null, backend: config.name };
  if (config.auth.type === 'bearer') {
    headers['Authorization'] = `Bearer ${await resolveCredentialSource(config.auth.token, target)}`;
  } else if (config.auth.type === 'basic') {
    const username = await resolveAuthValue(config.auth.username.from);
    const password = await resolveAuthValue(config.auth.password.from);
    headers['Authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } else if (config.auth.type === 'header') {
    headers[config.auth.name] = await resolveCredentialSource(config.auth.value, target);
  }
  return headers;
}

