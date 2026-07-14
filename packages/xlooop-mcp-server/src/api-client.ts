// api-client.ts · thin REST client for api.xlooop.com from Node.
//
// Responsibilities:
//   - read base URL from XLOOOP_API_BASE_URL env (default https://api.xlooop.com)
//   - attach bearer token from auth.ts
//   - serialize/deserialize JSON
//   - map non-2xx into structured XlooopMcpError
//   - support long-poll (configurable timeout, no buffering)
//
// What this does NOT do:
//   - retry logic (the MCP client decides whether to retry)
//   - caching (every tool call is fresh)
//   - rate limiting (Worker enforces; client just surfaces 429 as WORKER_ERROR)

import { requireToken } from './auth.js';
import { XlooopMcpError, errorFromHttpStatus } from './errors.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Override default timeout for long-poll endpoints (ms). 0 = no timeout. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function apiBase(): string {
  return (process.env.XLOOOP_API_BASE_URL ?? 'https://api.xlooop.com').replace(/\/+$/, '');
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = apiBase();
  let url = path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

export async function apiRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const token = await requireToken();
  const method = opts.method ?? 'GET';
  const url = buildUrl(path, opts.query);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(opts.body);
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new XlooopMcpError('TIMEOUT', `Request to ${path} exceeded ${timeoutMs}ms`, {
        hint: 'Increase the timeout via `timeoutMs` if the endpoint is long-polling, or check connectivity to api.xlooop.com.',
        cause: err,
      });
    }
    throw new XlooopMcpError('NETWORK_ERROR', `fetch failed for ${path}: ${(err as Error)?.message ?? String(err)}`, {
      cause: err,
      hint: 'Check network connectivity and that XLOOOP_API_BASE_URL (if set) points at a reachable host.',
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (res.status === 204) return null as T;

  const contentType = res.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  let parsed: unknown = null;
  if (isJson) {
    try {
      parsed = await res.json();
    } catch (e) {
      throw new XlooopMcpError('WORKER_ERROR', `failed to parse JSON response from ${path}`, {
        status: res.status,
        cause: e,
      });
    }
  } else {
    // Non-JSON 2xx is unexpected for our API; surface a structured error.
    const text = await res.text();
    if (!res.ok) {
      throw errorFromHttpStatus(res.status, { error: text.slice(0, 200) }, path);
    }
    throw new XlooopMcpError('WORKER_ERROR', `non-JSON response from ${path}: content-type=${contentType}`, {
      status: res.status,
    });
  }

  if (!res.ok) {
    throw errorFromHttpStatus(res.status, parsed as { error?: string; code?: string; request_id?: string }, path);
  }

  return parsed as T;
}

/** Health probe used by the CLI's `xlooop ping` subcommand. No auth required. */
export async function ping(): Promise<{ status: string; version?: string }> {
  const url = `${apiBase()}/api/v1/health`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new XlooopMcpError('WORKER_ERROR', `health probe failed · HTTP ${res.status}`, { status: res.status });
  }
  return res.json() as Promise<{ status: string; version?: string }>;
}
