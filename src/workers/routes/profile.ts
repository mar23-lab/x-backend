// profile.ts · GET /api/v1/me  (Stage 2 · real-data program)
//
// The authed user's own identity (Clerk JWT) + DB-backed account attributes
// (the `users` table). USER-SCOPED (no org_id required — a personal session can
// read its own profile, same auth contract as /api/v1/sources and /api/v1/layout).
// READ-ONLY.
//
// "real, or honestly-absent": Clerk is the identity source-of-record, so the DB
// `users` row may not exist yet for a brand-new sign-in. When it is absent the
// response falls back to the JWT identity (id + email) and the account fields are
// null — never fabricated. The frontend already renders Clerk identity directly
// (clerkIdentityAS); this endpoint adds the AUTHORITATIVE account attributes
// (status / approved_at / created_at) and is the foundation the Stage 3 members
// endpoint reuses.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';

export interface ProfileEnv extends AuthEnv {
  DATABASE_URL: string;
}

export interface ProfileVariables extends AuthVariables {
  dal: DalAdapter;
}

export const profileRoute = new Hono<{ Bindings: ProfileEnv; Variables: ProfileVariables }>();

profileRoute.get('/me', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const dal = ctx.get('dal');
    // Best-effort DB read: Clerk is the identity SoR, so a freshly-signed-in user
    // may have no `users` row yet. Never fail the endpoint on its absence.
    let dbUser = null;
    try {
      dbUser = await dal.getUser(auth.user_id);
    } catch (_) {
      dbUser = null;
    }
    return ctx.json({
      user: {
        id: auth.user_id,
        // Prefer the JWT's verified email; fall back to the DB row.
        email: auth.email ?? dbUser?.email ?? null,
        status: dbUser?.status ?? null,
        is_admin: dbUser?.is_admin ?? false,
        approved_at: dbUser?.approved_at ?? null,
        created_at: dbUser?.created_at ?? null,
        updated_at: dbUser?.updated_at ?? null,
      },
      // Honest provenance marker (mirrors the other read-models): whether a DB
      // account row backed this response, or it is JWT-only.
      source: dbUser ? 'db+jwt' : 'jwt',
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
