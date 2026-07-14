// current-work.ts · Wave I backend (260714) · the customer-safe Current Work read-projection.
//
// The canonical-lifecycle doctrine: "Chat explains the work, Events govern the work, Plans explain why
// the work matters — all three render the SAME canonical state." This route is that single server-derived
// projection: it answers "what needs you now" from persisted, tenant-scoped state so the three UI surfaces
// (Current Work card, Variant-A decide panel, Plan linkage) stop deriving state independently.
//
// It is a READ MODEL, not a new task domain (no new entity, no migration). It composes the EXISTING
// RLS-scoped DAL reads (getSession + listEvents) and returns counts-only, canonical ids the tenant
// already owns, coarse state labels, and one primary action — through the customer-safe envelope
// (withAuthority + withDataClass). Flag-gated default-OFF (CURRENT_WORK_PROJECTION_ENABLED): absent ⇒
// the route reports disabled and the code path is byte-identical to today. Mirrors the planRoute (G1)
// inert-until-flag precedent. INERT until the operator flips the flag after a Neon-branch read proof.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { withAuthority } from '../lib/allowed-actions';
import { envFlagTrue } from '../lib/env-flag';
import { resolveScopedWorkspace } from '../lib/operator-workspace-scope';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';

export interface CurrentWorkEnv extends AuthEnv {
  DATABASE_URL: string;
  // Default-OFF: deliberately NOT declared in wrangler.toml ⇒ inert, code-path-identical.
  CURRENT_WORK_PROJECTION_ENABLED?: string;
  // JA (260714) · operator-workspace-scope. Default-OFF (undeclared in wrangler.toml) ⇒ the resolved
  // workspace is ALWAYS auth.workspace_id (byte-identical). ON: an owner/active-member operator may scope
  // this projection to a workspace they own via ?workspace_id=; an unauthorized override is a hard 403.
  OPERATOR_WORKSPACE_SCOPE_ENABLED?: string;
}
export interface CurrentWorkVariables extends AuthVariables {
  dal: DalAdapter;
}

export const currentWorkRoute = new Hono<{ Bindings: CurrentWorkEnv; Variables: CurrentWorkVariables }>();

const clean = (t: string | null | undefined): string => String(t ?? '').replace(/^Packet · /, '').trim();

currentWorkRoute.get('/current-work', async (ctx) => {
  try {
    if (!envFlagTrue(ctx.env.CURRENT_WORK_PROJECTION_ENABLED)) {
      ctx.status(404);
      return ctx.json({ error: 'current-work projection is not enabled', code: 'FEATURE_DISABLED', request_id: ctx.get('request_id') });
    }
    const auth = ctx.get('auth');
    const dal = ctx.get('dal');

    // JA (260714) · resolve the effective read workspace. Flag OFF (default) ⇒ auth.workspace_id
    // unconditionally (byte-identical). Flag ON ⇒ an owner/active-member operator may scope to a
    // workspace they own via ?workspace_id=; an unauthorized override is a hard 403 (never a silent
    // fall-back to the token org).
    const scoped = await resolveScopedWorkspace(
      ctx as never,
      ctx.env.OPERATOR_WORKSPACE_SCOPE_ENABLED,
      auth.workspace_id,
      auth.user_id,
      ctx.req.query('workspace_id'),
      dal,
    );
    if (!scoped.ok) return scoped.res;
    const workspaceId = scoped.ws;

    // Existing RLS-scoped read. Active project = the session's first project unless ?project_id given.
    const session = await dal.getSession(auth.user_id, workspaceId);
    const projects = Array.isArray(session.projects) ? session.projects : [];
    const projectId = ctx.req.query('project_id') || (projects[0] ? projects[0].id : null);

    const page = await dal.listEvents(workspaceId, { role: auth.role, limit: 200, top_level: true })
      .catch(() => ({ events: [], pagination: { has_more: false, next_before: null } }));
    const inScope = (e: { project_id: string | null }) => !projectId || e.project_id === projectId || e.project_id === null;
    const events = page.events.filter(inScope);

    const pending = events.filter((e) => e.status === 'needs_review' && e.approval_state !== 'approved');
    const blocked = events.filter((e) => e.status === 'blocked');
    const done = events.filter((e) => e.status === 'completed' || e.status === 'approved');

    // The single focal item + its plain-language primary action (mirrors the frontend H2 state machine).
    let focus: null | { event_id: string; intent_id: string | null; project_id: string | null; title: string; state: string; status_label: string; next: string; primary_action: { code: string; label: string } | null } = null;
    if (pending.length === 1) {
      const it = pending[0];
      focus = { event_id: it.id, intent_id: it.intent_id, project_id: it.project_id, title: clean(it.summary), state: 'needs_review', status_label: 'Waiting for your approval', next: 'Review it and record your sign-off', primary_action: { code: 'review_result', label: 'Review now' } };
    } else if (pending.length > 1) {
      const it = pending[0];
      focus = { event_id: it.id, intent_id: it.intent_id, project_id: it.project_id, title: pending.length + ' items are waiting on you', state: 'needs_review', status_label: 'Waiting for your approval', next: 'Open the review queue', primary_action: { code: 'open_queue', label: 'Open queue' } };
    } else if (blocked.length >= 1) {
      const b = blocked[0];
      focus = { event_id: b.id, intent_id: b.intent_id, project_id: b.project_id, title: clean(b.summary), state: 'blocked', status_label: 'Blocked', next: 'Resolve the blocker to continue', primary_action: { code: 'resolve_blocker', label: 'Resolve' } };
    } else {
      focus = { event_id: '', intent_id: null, project_id: projectId, title: 'No work is waiting on you', state: 'all_clear', status_label: 'All clear', next: 'Describe the outcome you want', primary_action: null };
    }

    const total = events.length;
    const payload = {
      schema_id: 'xlooop.current_work_projection.v1',
      generated_at: new Date().toISOString(),
      workspace_id: workspaceId,
      project_id: projectId,
      // canonical, coarse, counts-only (customer-safe doctrine: never evidence ids, never engine chains)
      focus,
      counts: {
        needs_you: pending.length,
        blocked: blocked.length,
        done: done.length,
        total,
        done_pct: total > 0 ? Math.round((done.length / total) * 100) : 0,
      },
      // evidence is a COUNT, never ids
      evidence_count: events.filter((e) => Boolean(e.evidence_link)).length,
    };

    return ctx.json(withDataClass(withAuthority(payload, auth, 'current_work'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
