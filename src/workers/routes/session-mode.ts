// session-mode.ts · Wave B · PATCH /api/v1/session/mode — the audited write path for the canonical
// operating mode (watch/test/operator). USER + WORKSPACE scoped: the caller only ever sets their OWN mode
// for their current workspace (auth.user_id + auth.workspace_id from the JWT). Mounted in the org-scoped
// protectedRoutes group. Any workspace member may set their own mode; every flip is recorded in audit_logs
// (see setOperatingModeRow).
//
// AUTHORITY NOTE (OA cutover): once ENTITLEMENT_ENFORCEMENT is flipped on, this mode is AUTHORITY-BEARING for
// governed spine writes — canActOnSpine requires operator mode, so a watch/test session cannot write. The
// server reads THIS persisted value (never a client-asserted mode), and GET /session projects the resulting
// per-action authority (spine_authority) so the UI enables a control iff the write will succeed. Setting mode
// here is therefore the deliberate "enter operator to act" step, not merely a display preference.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { isOperatingMode, OPERATING_MODES } from '../dal/session-preferences-store';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';

export interface SessionModeVariables extends AuthVariables {
  dal: DalAdapter;
}

export const sessionModeRoute = new Hono<{ Bindings: AuthEnv; Variables: SessionModeVariables }>();

// The caller's max client-exposure tier, derived from role — the Visibility identity axis.
function visibilityForRole(role: string): string {
  return role === 'client' ? 'client-visible' : role === 'viewer' ? 'agency-visible' : 'system-internal';
}

sessionModeRoute.patch('/session/mode', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    if (!auth.workspace_id) {
      return errorEnvelope(ctx, { status: 403, code: 'NO_WORKSPACE', message: 'no workspace in session' });
    }
    let body: { mode?: unknown } = {};
    try { body = (await ctx.req.json()) as { mode?: unknown }; } catch { body = {}; }
    if (!isOperatingMode(body?.mode)) {
      return errorEnvelope(ctx, {
        status: 400, code: 'INVALID_MODE',
        message: `mode must be one of: ${OPERATING_MODES.join(', ')}`,
      });
    }
    const dal = ctx.get('dal');
    const saved = await dal.setOperatingMode(auth.user_id, auth.workspace_id, body.mode, auth.user_id);
    if (!saved.session_mode_revision_id || !saved.audit_event_id) {
      return errorEnvelope(ctx, { status: 500, code: 'SESSION_MODE_RECEIPT_MISSING', message: 'session mode write did not produce a durable audit receipt' });
    }
    // Echo the updated 4-axis identity block (same shape GET /session returns) so the caller can re-sync.
    return ctx.json({
      identity: {
        role: auth.role,
        operating_mode: saved.operating_mode,
        session_mode: 'authenticated',
        visibility: visibilityForRole(auth.role),
      },
      session_mode_revision_id: saved.session_mode_revision_id,
      audit_event_id: saved.audit_event_id,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
