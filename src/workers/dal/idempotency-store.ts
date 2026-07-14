// idempotency-store.ts · Wave Y (260711) · the reserve-first idempotency store (migration 065).
//
// THREE operations, all on (workspace_id, idempotency_key):
//   reserveIdempotencyKey  → INSERT ... ON CONFLICT DO NOTHING RETURNING id. Winner gets {status:'owned'}
//     and must execute the handler. On conflict, SELECT the existing row: a completed row (response_status
//     NOT NULL) → {status:'replay', responseStatus, body}; an in-flight reservation → {status:'in_progress'}.
//   completeIdempotencyKey → UPDATE the owned row with the handler's 2xx response (status + body).
//   releaseIdempotencyKey  → DELETE the owned row when the handler did NOT 2xx, so a real retry can proceed.
//
// DEGRADE-SAFE / FAIL-OPEN: if the table is missing (pre-065) or the query throws, reserve returns 'owned'
// (execute normally, no dedupe) — a flag flipped on before the operator applies 065 must NEVER 500 a write.
// complete/release swallow errors for the same reason. Correctness (dedupe) is best-effort; availability
// of the write is not.

import type { Sql } from '../db/client';

export type ReserveResult =
  | { status: 'owned' }
  | { status: 'in_progress' }
  | { status: 'replay'; responseStatus: number; body: unknown };

function clean(v: string): string {
  return String(v || '').trim();
}

/** Attempt to claim the key. Fail-open to 'owned' (execute, no dedupe) on any error / missing table. */
export async function reserveIdempotencyKey(
  sql: Sql,
  workspaceId: string,
  key: string,
  route: string,
): Promise<ReserveResult> {
  const ws = clean(workspaceId);
  const k = clean(key);
  if (!ws || !k) return { status: 'owned' };
  try {
    const inserted = (await sql/*sql*/`
      INSERT INTO idempotency_keys (workspace_id, idempotency_key, route)
      VALUES (${ws}, ${k}, ${clean(route)})
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
      RETURNING id
    `) as Array<Record<string, unknown>>;
    if (inserted.length > 0) return { status: 'owned' };

    const existing = (await sql/*sql*/`
      SELECT response_status, response_body
      FROM idempotency_keys
      WHERE workspace_id = ${ws} AND idempotency_key = ${k}
      LIMIT 1
    `) as Array<Record<string, unknown>>;
    const row = existing[0];
    if (!row) return { status: 'owned' }; // vanished between INSERT and SELECT — execute
    if (row.response_status == null) return { status: 'in_progress' };
    return { status: 'replay', responseStatus: Number(row.response_status) || 200, body: row.response_body ?? null };
  } catch {
    return { status: 'owned' }; // pre-065 schema / transient → execute normally (fail-open)
  }
}

/** Persist the owned row's successful response so future retries replay it. Best-effort. */
export async function completeIdempotencyKey(
  sql: Sql,
  workspaceId: string,
  key: string,
  responseStatus: number,
  body: unknown,
): Promise<void> {
  const ws = clean(workspaceId);
  const k = clean(key);
  if (!ws || !k) return;
  try {
    await sql/*sql*/`
      UPDATE idempotency_keys
      SET response_status = ${Math.trunc(Number(responseStatus) || 200)},
          response_body = ${JSON.stringify(body ?? null)}::jsonb,
          completed_at = now()
      WHERE workspace_id = ${ws} AND idempotency_key = ${k} AND response_status IS NULL
    `;
  } catch { /* best-effort — the response is already being returned to the caller */ }
}

/** Drop an un-completed reservation after a non-2xx handler, so a genuine retry can proceed. Best-effort. */
export async function releaseIdempotencyKey(sql: Sql, workspaceId: string, key: string): Promise<void> {
  const ws = clean(workspaceId);
  const k = clean(key);
  if (!ws || !k) return;
  try {
    await sql/*sql*/`
      DELETE FROM idempotency_keys
      WHERE workspace_id = ${ws} AND idempotency_key = ${k} AND response_status IS NULL
    `;
  } catch { /* best-effort */ }
}
