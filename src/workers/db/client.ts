// client.ts · Neon serverless Postgres client setup for Cloudflare Workers
//
// Authority: BACKEND_ADR_001.md · uses @neondatabase/serverless HTTP driver
//
// Why HTTP driver (not standard pg):
//   - CF Workers do not support TCP sockets (V8 isolates have no Node net module)
//   - Neon's HTTP driver makes auto-pooled queries via HTTPS
//   - Compatible with edge runtimes (Workers, Vercel Edge, Deno Deploy)
//
// Usage:
//   const sql = neonClient(env.DATABASE_URL);
//   const rows = await sql`SELECT * FROM operation_events WHERE workspace_id = ${workspaceId} LIMIT 50`;

import { neon, neonConfig } from '@neondatabase/serverless';

// Configure once per worker isolate. fetchConnectionCache enables HTTP keep-alive across queries.
neonConfig.fetchConnectionCache = true;

export type Sql = ReturnType<typeof neon>;

/** D2 (260709) · the neon HTTP driver's `.transaction()` method is not surfaced on the base Sql type, so
 *  call sites cast it. This is the TYPED seam for that one adapter-edge gap (replaces `(sql as any).transaction`
 *  — a typed cast, not `any`, so untypedness never propagates off the sql object). Each query in the batch
 *  returns its own result array, in order. */
export type SqlTx = Sql & { transaction: (queries: readonly unknown[]) => Promise<unknown[][]> };

/**
 * Returns a tagged-template SQL function bound to the given Neon DATABASE_URL.
 * Throws if databaseUrl is missing or malformed.
 */
export function neonClient(databaseUrl: string | undefined | null): Sql {
  if (!databaseUrl || typeof databaseUrl !== 'string' || !databaseUrl.startsWith('postgres')) {
    throw new Error(
      'DATABASE_URL secret is missing or malformed; set via `wrangler secret put DATABASE_URL`'
    );
  }
  return neon(databaseUrl);
}

/**
 * Lightweight health probe — runs `SELECT 1` to confirm Neon connectivity.
 * Used by /api/v1/health when ?deep=1 is requested (optional).
 */
export async function pingDatabase(sql: Sql): Promise<boolean> {
  try {
    const result = (await sql`SELECT 1 AS ok`) as Array<{ ok: number }>;
    return Array.isArray(result) && result.length === 1 && result[0]?.ok === 1;
  } catch {
    return false;
  }
}
