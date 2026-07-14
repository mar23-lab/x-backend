// admin.ts · Admin authorization middleware
//
// Authority: docs/architecture/backend/AUTH_TENANCY_MODEL.md §Admin identity
//
// Two ways a user is granted admin:
//   1. Their user_id is in env.ADMIN_USER_IDS (comma-separated list in wrangler.toml [vars])
//   2. Their Neon users.is_admin column is true (settable via DB; future admin UI)
//
// This middleware must run AFTER clerkAuth — it reads ctx.var.auth.user_id.

import { MiddlewareHandler } from 'hono';
import type { DalAdapter } from '../dal/DalAdapter';
import type { AuthContext } from '../dal/types';
import type { AuthEnv, AuthVariables } from './auth';

export interface AdminEnv extends AuthEnv {
  ADMIN_USER_IDS?: string;   // CSV of Clerk user_ids that have admin privilege
}

export type AdminVariables = AuthVariables & {
  dal: DalAdapter;
};

export function envAdminIds(env: AdminEnv): Set<string> {
  const raw = (env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return new Set(raw);
}

export function isAdminFromEnv(env: AdminEnv, userId: string): boolean {
  return envAdminIds(env).has(userId);
}

/**
 * Requires the authenticated user to be an admin.
 * Returns 403 FORBIDDEN if not.
 */
export function requireAdmin(): MiddlewareHandler<{
  Bindings: AdminEnv;
  Variables: AdminVariables;
}> {
  return async (ctx, next) => {
    const auth = ctx.get('auth') as AuthContext | undefined;
    if (!auth) {
      // Should never happen if clerkAuth ran first
      ctx.status(401);
      return ctx.json({
        error: 'auth context missing — clerkAuth must run first',
        code: 'UNAUTHORIZED',
        request_id: (ctx.get('request_id') as string) || '',
      });
    }

    // Fast path: env-var-listed admin
    if (isAdminFromEnv(ctx.env, auth.user_id)) {
      auth.is_admin = true;
      ctx.set('auth', auth);
      await next();
      return;
    }

    // Slow path: DB lookup
    const dal = ctx.get('dal');
    if (dal) {
      try {
        const user = await dal.getUser(auth.user_id);
        if (user?.is_admin === true) {
          auth.is_admin = true;
          ctx.set('auth', auth);
          await next();
          return;
        }
      } catch {
        // DB unavailable — fall through to 403 (do not bypass)
      }
    }

    ctx.status(403);
    return ctx.json({
      error: 'admin privilege required',
      code: 'FORBIDDEN',
      request_id: (ctx.get('request_id') as string) || '',
    });
  };
}
