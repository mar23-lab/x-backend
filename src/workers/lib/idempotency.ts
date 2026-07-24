// idempotency.ts · Wave Y (260711) · the critical-path Idempotency-Key wrapper for governed writes.
//
// ONE wrap around a write handler makes a client retry replay the first response instead of double-writing:
//
//   operationalSpineRoute.post('/packets', (ctx) =>
//     withIdempotency(ctx, 'POST /packets', async () => { ...existing handler... }));
//
// DEFAULT (IDEMPOTENCY_ENABLED != 'true') OR no Idempotency-Key header: returns handler() directly —
// BYTE-IDENTICAL, no DB touch. FLAG ON + header present: reserve-first (idempotency-store) →
//   owned       → execute; on 2xx complete(store response); on non-2xx release(so a retry can proceed)
//   in_progress → 409 IDEMPOTENCY_IN_PROGRESS (a concurrent request holds the key)
//   replay      → the stored response, tagged Idempotency-Replayed: true, WITHOUT re-executing
//
// Reserve fails OPEN to 'owned' if the table is missing (pre-065) — availability of the write is never
// sacrificed to the dedupe. Unlike metering this is on the CRITICAL PATH (synchronous), not waitUntil.

import type { Context } from 'hono';
import { neonClient, type Sql } from '../db/client';
import { envFlagTrue } from './env-flag';
import { reserveIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../dal/idempotency-store';

export function idempotencyEnabled(env: unknown): boolean {
  return envFlagTrue((env as { IDEMPOTENCY_ENABLED?: string } | undefined)?.IDEMPOTENCY_ENABLED);
}

/** Injectable Sql seam (mirrors spine-authority sqlFor): a test may pre-set ctx.get('sql'); else build from env. */
function sqlFor(ctx: Context): Sql {
  return (ctx.get('sql') as Sql | undefined) ?? neonClient((ctx.env as { DATABASE_URL?: string }).DATABASE_URL);
}

export async function withIdempotency(
  ctx: Context,
  route: string,
  handler: () => Promise<Response>,
): Promise<Response> {
  const key = String(ctx.req.header('Idempotency-Key') || '').trim();
  const auth = (ctx.get('auth') as { workspace_id?: string } | undefined) || {};
  const workspaceId = String(auth.workspace_id || '').trim();

  // Byte-identical fast path: flag off, or no key, or no tenant scope.
  if (!idempotencyEnabled(ctx.env) || !key || !workspaceId) return handler();

  const sql = sqlFor(ctx);
  const reserved = await reserveIdempotencyKey(sql, workspaceId, key, route);

  if (reserved.status === 'replay') {
    return ctx.json(reserved.body as never, (reserved.responseStatus as never), { 'Idempotency-Replayed': 'true' });
  }
  if (reserved.status === 'in_progress') {
    return ctx.json(
      { error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'a request with this Idempotency-Key is already being processed' } },
      409 as never,
    );
  }

  // status === 'owned' → this request owns the reservation. The store intentionally
  // fails open, so this is retry protection rather than a transactional exactly-once guarantee.
  let res: Response;
  try {
    res = await handler();
  } catch (err) {
    await releaseIdempotencyKey(sql, workspaceId, key);
    throw err;
  }

  if (res.status >= 200 && res.status < 300) {
    let body: unknown = null;
    try { body = await res.clone().json(); } catch { body = null; }
    if (body !== null) {
      await completeIdempotencyKey(sql, workspaceId, key, res.status, body);
    } else {
      await releaseIdempotencyKey(sql, workspaceId, key); // non-JSON 2xx — don't pin a body we can't replay
    }
  } else {
    await releaseIdempotencyKey(sql, workspaceId, key); // 4xx/5xx — let a genuine retry through
  }
  return res;
}

const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Group-level applicator: `route.use('*', idempotencyMiddleware())` covers every mutating write in a
 * route group with the same reserve-first semantics as withIdempotency, uniformly and for future routes.
 * GET and the byte-identical fast path (flag off / no key / no tenant / auth not yet set) pass
 * straight through — the guards make it ordering-robust: if auth isn't populated it degrades to no-dedupe,
 * never a break.
 */
export function idempotencyMiddleware() {
  return async (ctx: Context, next: () => Promise<void>): Promise<Response | void> => {
    const method = ctx.req.method.toUpperCase();
    if (!IDEMPOTENT_METHODS.has(method)) return next();

    const key = String(ctx.req.header('Idempotency-Key') || '').trim();
    const auth = (ctx.get('auth') as { workspace_id?: string } | undefined) || {};
    const workspaceId = String(auth.workspace_id || '').trim();
    if (!idempotencyEnabled(ctx.env) || !key || !workspaceId) return next();

    const sql = sqlFor(ctx);
    let route = method;
    try { route = `${method} ${new URL(ctx.req.url).pathname}`; } catch { /* keep method-only */ }
    const reserved = await reserveIdempotencyKey(sql, workspaceId, key, route);

    if (reserved.status === 'replay') {
      return ctx.json(reserved.body as never, (reserved.responseStatus as never), { 'Idempotency-Replayed': 'true' });
    }
    if (reserved.status === 'in_progress') {
      return ctx.json(
        { error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'a request with this Idempotency-Key is already being processed' } },
        409 as never,
      );
    }

    try {
      await next();
    } catch (err) {
      await releaseIdempotencyKey(sql, workspaceId, key);
      throw err;
    }

    const res = ctx.res;
    if (res && res.status >= 200 && res.status < 300) {
      let body: unknown = null;
      try { body = await res.clone().json(); } catch { body = null; }
      if (body !== null) await completeIdempotencyKey(sql, workspaceId, key, res.status, body);
      else await releaseIdempotencyKey(sql, workspaceId, key);
    } else {
      await releaseIdempotencyKey(sql, workspaceId, key);
    }
  };
}
