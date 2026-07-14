// diagnose.ts · R43.17 · OPERATOR-GATED GET /api/v1/diagnose-user/:user_id
//
// Returns the DB-side entitlement state for a given Clerk user_id. Used to debug
// "I signed in but I'm stuck at verifying" without operator DevTools/console
// round-trips.
//
// SECURITY (260710, operator decision — was public, now operator-gated): this
// endpoint returns a privilege flag (is_admin), account lifecycle timestamps,
// and the NAMES + roles of the user's workspaces (business-relationship data).
// That is NOT "safe for public" — the prior "no PII" claim was inaccurate. It
// is now gated behind MBP_OWNER_USER_ID (the same operator-identity gate as
// mbp-projection.ts): a missing token → 401, a non-operator token → 403. The
// consumer was always the OPERATOR (the next_action hints are operator CLI
// commands), and nothing calls it unauthenticated, so gating loses no utility.
//
// Removal: once auth flow is stable and we have ops dashboards, this can be
// retired. Until then, it's the fastest path to triage stuck sign-ins.

import { Hono } from 'hono';
import { verifyToken } from '@clerk/backend';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';

export interface DiagnoseEnv extends AuthEnv {
  DATABASE_URL: string;
  MBP_OWNER_USER_ID?: string; // Clerk user_id of the operator (e.g. user_3EI...)
}

export type DiagnoseVariables = {
  request_id: string;
  dal: DalAdapter;
};

export const diagnoseRoute = new Hono<{ Bindings: DiagnoseEnv; Variables: DiagnoseVariables }>();

// Operator-identity gate — mirrors mbp-projection.ts verifyMbpOwner: fail-closed
// when unconfigured (503), missing bearer (401), non-owner (403). Returns null on
// success (the caller proceeds); returns a Response on any failure.
async function requireOperator(ctx: {
  env: DiagnoseEnv; req: { header: (n: string) => string | undefined };
  get: (k: 'request_id') => string; status: (n: number) => void; json: (b: unknown) => Response;
}): Promise<Response | null> {
  const requestId = ctx.get('request_id') || '';
  const ownerUserId = (ctx.env.MBP_OWNER_USER_ID || '').trim();
  if (!ownerUserId) {
    ctx.status(503);
    return ctx.json({ error: 'MBP_OWNER_USER_ID is not configured on this Worker', code: 'SERVICE_UNAVAILABLE', request_id: requestId });
  }
  const authHeader = ctx.req.header('Authorization') || ctx.req.header('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    ctx.status(401);
    return ctx.json({ error: 'missing bearer token', code: 'UNAUTHORIZED', request_id: requestId });
  }
  try {
    const payload = await verifyToken(token, { secretKey: ctx.env.CLERK_SECRET_KEY });
    if (String(payload?.sub || '') !== ownerUserId) {
      ctx.status(403);
      return ctx.json({ error: 'this endpoint is restricted to the platform operator', code: 'FORBIDDEN', request_id: requestId });
    }
    return null;
  } catch {
    ctx.status(401);
    return ctx.json({ error: 'jwt verification failed', code: 'UNAUTHORIZED', request_id: requestId });
  }
}

diagnoseRoute.get('/diagnose-user/:user_id', async (ctx) => {
  const requestId = (ctx.get('request_id') as string) || '';

  // SECURITY gate: operator-only (was public pre-260710).
  const denied = await requireOperator(ctx as never);
  if (denied) return denied;

  const userId = ctx.req.param('user_id');

  if (!userId || !userId.startsWith('user_')) {
    ctx.status(400);
    return ctx.json({
      error: 'user_id query param required (format: user_xxxxxxxx)',
      code: 'VALIDATION_ERROR',
      request_id: requestId,
    });
  }

  // Pull the DAL from middleware. We use the underlying neon client directly
  // for these readonly diagnostic queries because we don't want to depend on
  // adding new methods to the DAL interface just for diagnostics.
  const dal = ctx.get('dal') as DalAdapter & { sql?: <T>(...args: unknown[]) => Promise<T> };
  // WorkersDalAdapter exposes `sql` as a private field; access via cast since
  // the diagnostic route is intentionally narrow.
  const sql = (dal as unknown as { sql: <T>(strings: TemplateStringsArray, ...args: unknown[]) => Promise<T> }).sql;

  try {
    // 1. Does the user row exist? what's its status?
    const userRows = await sql<Array<{
      id: string;
      status: string;
      is_admin: boolean;
      approved_at: string | null;
      created_at: string;
    }>>`SELECT id, status, is_admin, approved_at, created_at FROM users WHERE id = ${userId} LIMIT 1`;
    const user = userRows[0];

    // 2. How many active workspace_members rows?
    const memberRows = await sql<Array<{
      workspace_id: string;
      role: string;
      status: string;
      activated_at: string | null;
    }>>`SELECT workspace_id, role, status, activated_at FROM workspace_members WHERE user_id = ${userId} ORDER BY activated_at ASC NULLS LAST`;

    // 3. For each membership, fetch workspace name (no PII)
    const workspaceIds = memberRows.map(m => m.workspace_id);
    const workspaceRows = workspaceIds.length > 0
      ? await sql<Array<{ id: string; name: string; slug: string | null }>>`
          SELECT id, name, slug FROM workspaces WHERE id = ANY(${workspaceIds})
        `
      : [];
    const wsById = new Map(workspaceRows.map(w => [w.id, w]));

    return ctx.json({
      _meta: {
        schema: 'xlooop.diagnose_user_endpoint.v1',
        endpoint: '/api/v1/diagnose-user',
        request_id: requestId,
        access: 'operator-only (MBP_OWNER_USER_ID gate) · returns is_admin + workspace names/roles',
      },
      query: { user_id: userId },
      diagnosis: {
        user_row_exists: !!user,
        user_status: user?.status ?? null,
        user_is_admin: user?.is_admin ?? null,
        user_approved_at: user?.approved_at ?? null,
        user_created_at: user?.created_at ?? null,
        active_memberships_count: memberRows.filter(m => m.status === 'active').length,
        total_memberships_count: memberRows.length,
        memberships: memberRows.map(m => ({
          workspace_id: m.workspace_id,
          workspace_name: wsById.get(m.workspace_id)?.name ?? null,
          workspace_slug: wsById.get(m.workspace_id)?.slug ?? null,
          role: m.role,
          status: m.status,
          activated_at: m.activated_at,
        })),
      },
      next_action_hint: !user
        ? 'User row does NOT exist in DB. Run the seed for this user_id (npm run onboard-customer or psql).'
        : user.status === 'pending'
          ? 'User exists but status=pending. Approve via npm run admin:approve-user ' + userId
          : user.status !== 'approved'
            ? `User status='${user.status}' is a terminal blocker. Admin override required.`
            : memberRows.filter(m => m.status === 'active').length === 0
              ? 'User is approved but has zero active workspace_members. Run seed to add membership row.'
              : 'User is approved + has active membership. They should be landing in the workspace.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    ctx.status(500);
    return ctx.json({
      error: `diagnose-user query failed: ${msg}`,
      code: 'INTERNAL_ERROR',
      request_id: requestId,
    });
  }
});
