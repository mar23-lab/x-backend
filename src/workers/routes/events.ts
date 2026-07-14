// events.ts · GET /api/v1/events + POST /api/v1/events
//
// Authority: API_CONTRACT_V1.md §GET/POST /api/v1/events

import { Hono } from 'hono';
import { authorizeGovernedWrite } from '../lib/spine-authority';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { withAuthority } from '../lib/allowed-actions';
import { envFlagTrue } from '../lib/env-flag';
import { ROLLBACK_WINDOW_DAYS } from '../lib/self-service';
import { VALID_STATUSES, VALID_SOURCE_TOOLS } from '../lib/event-validation';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type {
  EventListOpts,
  EventStatus,
  SourceTool,
  HarnessFlowEventInput,
} from '../dal/types';

export interface EventsEnv extends AuthEnv {
  DATABASE_URL: string;
  CUSTOMER_SELF_SERVICE_ENABLED?: string; // P.9 (260628) · gates customer event soft-delete/restore + recently-deleted read. Default OFF → dormant until operator browser-verify. Parsed via envFlagTrue (quote-tolerant).
}

export interface EventsVariables extends AuthVariables {
  dal: DalAdapter;
}

export const eventsRoute = new Hono<{ Bindings: EventsEnv; Variables: EventsVariables }>();

// ---- GET /api/v1/events ----
eventsRoute.get('/events', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id, role, user_id } = auth;
    const dal = ctx.get('dal');

    const url = new URL(ctx.req.url);
    const limitRaw = url.searchParams.get('limit');
    const before = url.searchParams.get('before') || undefined;
    const project_id = url.searchParams.get('project_id') || undefined;
    const status = url.searchParams.get('status') as EventStatus | null;
    const source_tool = url.searchParams.get('source_tool') as SourceTool | null;
    // OS-4 P1 · thread params — OPT-IN only; absent params leave every existing consumer
    // (digest agent, read-models, snapshots) byte-identical. parent_event_id=X fetches X's
    // replies; top_level=true rolls up (excludes replies).
    const parent_event_id = url.searchParams.get('parent_event_id') || undefined;
    const top_level = url.searchParams.get('top_level') === 'true';

    const limit = limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 50) : 50;

    if (status && !VALID_STATUSES.has(status)) {
      ctx.status(400);
      return ctx.json({
        error: `invalid status: ${status}`,
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    if (source_tool && !VALID_SOURCE_TOOLS.has(source_tool)) {
      ctx.status(400);
      return ctx.json({
        error: `invalid source_tool: ${source_tool}`,
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }

    const opts: EventListOpts = {
      limit,
      role,
      ...(before ? { before } : {}),
      ...(project_id ? { project_id } : {}),
      ...(status ? { status } : {}),
      ...(source_tool ? { source_tool } : {}),
      ...(parent_event_id ? { parent_event_id } : {}),
      ...(top_level ? { top_level } : {}),
    };

    // R54-Stage2 · operator overlay (mirror of the GET /provenance overlay).
    // The operator's real activity (e.g. GitHub events from Stage 1) lands in
    // whichever of THEIR orgs the producer wrote to — not necessarily the JWT
    // workspace. For the VERIFIED platform owner only, list events across the
    // operator's whole identity set so the cockpit chat surfaces all of it.
    // Every other caller keeps the strict workspace-scoped path — no change.
    // ACCESS is gated on the primary owner; linked ids only EXPAND scope.
    const ownerUserId = String((ctx.env as { MBP_OWNER_USER_ID?: string })?.MBP_OWNER_USER_ID || '').trim();
    if (ownerUserId && user_id && user_id === ownerUserId
        && typeof (dal as { listEventsForOperator?: unknown }).listEventsForOperator === 'function') {
      const linkedIds = String((ctx.env as { MBP_OWNER_LINKED_USER_IDS?: string })?.MBP_OWNER_LINKED_USER_IDS || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const page = await (dal as unknown as {
        listEventsForOperator: (ids: string[], o: EventListOpts) => Promise<unknown>;
      }).listEventsForOperator([ownerUserId, ...linkedIds], opts);
      return ctx.json(withDataClass(withAuthority(page as Record<string, unknown>, auth, 'event'), 'live'));
    }

    // Non-operator path is STRICTLY workspace-scoped. Because this route is now
    // mounted org-OPTIONAL (so the operator overlay above can run orgless), we
    // must re-assert the org requirement here for everyone else — otherwise an
    // orgless customer JWT would read with workspace_id='' (cross-tenant risk).
    if (!workspace_id) {
      ctx.status(403);
      return ctx.json({
        error: 'JWT missing org_id — personal sessions cannot access workspace data',
        code: 'FORBIDDEN',
        request_id: ctx.get('request_id'),
      });
    }

    const page = await dal.listEvents(workspace_id, opts);
    return ctx.json(withDataClass(withAuthority(page as unknown as Record<string, unknown>, auth, 'event'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ---- E1/E3 (260628) · customer self-service event soft-delete + restore + recently-deleted ----
//
// SECURITY INVARIANT (P.3): the tenant is ALWAYS the verified JWT's workspace_id — never a
// request-body target. There is NO operator-overlay branch here (that exists only on the
// org-OPTIONAL operator paths above). So a customer can only ever touch THEIR own workspace's
// events; a foreign/guessed event id returns updated:0 → 404 (the DAL's `WHERE workspace_id`).
// All three routes ship dormant behind CUSTOMER_SELF_SERVICE_ENABLED (default OFF).
async function selfServiceDenial(
  ctx: Parameters<typeof authorizeGovernedWrite>[0],
  env: EventsEnv,
  auth: { workspace_id?: string; role?: string },
): Promise<{ status: number; code: string; message: string } | null> {
  if (!envFlagTrue(env.CUSTOMER_SELF_SERVICE_ENABLED)) return { status: 403, code: 'SELF_SERVICE_DISABLED', message: 'self-service is not enabled' };
  // org-reassert: this route family is mounted org-OPTIONAL, so an orgless JWT would otherwise
  // act with workspace_id='' (cross-tenant risk). Mirror the GET handler's re-assert (above).
  if (!auth.workspace_id) return { status: 403, code: 'FORBIDDEN', message: 'an organization is required' };
  // P5(b): one-core governed gate (flag-off == the prior owner/operator role predicate, byte-identical).
  if (!(await authorizeGovernedWrite(ctx, 'event:self_service')).allowed) return { status: 403, code: 'FORBIDDEN', message: 'owner role required' };
  return null;
}

// GET /api/v1/events/archived · "recently deleted" within the restore window (powers the rollback panel).
eventsRoute.get('/events/archived', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const denial = await selfServiceDenial(ctx, ctx.env, auth);
    if (denial) return errorEnvelope(ctx, denial);
    const items = await ctx.get('dal').listArchivedEvents(auth.workspace_id!, ROLLBACK_WINDOW_DAYS);
    return ctx.json({ ok: true, window_days: ROLLBACK_WINDOW_DAYS, items });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// DELETE /api/v1/events/:id · reversible soft-delete (sets archived_at). Restorable for ROLLBACK_WINDOW_DAYS.
eventsRoute.delete('/events/:id', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const denial = await selfServiceDenial(ctx, ctx.env, auth);
    if (denial) return errorEnvelope(ctx, denial);
    const id = ctx.req.param('id');
    const { updated } = await ctx.get('dal').archiveEvent(auth.workspace_id!, id);
    if (!updated) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'event not found in this workspace' });
    return ctx.json({ ok: true, id, archived: true });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /api/v1/events/:id/restore · undo a soft-delete (clears archived_at) within the window.
eventsRoute.post('/events/:id/restore', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const denial = await selfServiceDenial(ctx, ctx.env, auth);
    if (denial) return errorEnvelope(ctx, denial);
    const id = ctx.req.param('id');
    const { updated } = await ctx.get('dal').restoreEvent(auth.workspace_id!, id);
    if (!updated) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'no restorable event with that id in this workspace' });
    return ctx.json({ ok: true, id, restored: true });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ---- POST /api/v1/events ----
eventsRoute.post('/events', async (ctx) => {
  try {
    const { workspace_id, role, user_id } = ctx.get('auth');
    const dal = ctx.get('dal');

    // R55-3b · Operator chat-composer write overlay. The verified platform owner
    // runs orgless personal sessions (role='viewer', workspace_id=''), so the
    // normal org+role gate below would 403 their own cockpit chat composer — the
    // exact mirror of the GET /events operator overlay (lines ~87). To write
    // WITHOUT widening any tenant boundary, the operator must name a
    // `target_workspace_id` and the DAL verifies THEY own it
    // (owner_user_id ∈ operator id set) before any insert. Non-operators never
    // reach this branch; a customer JWT still hits the strict gate below.
    const ownerUserId = String((ctx.env as { MBP_OWNER_USER_ID?: string })?.MBP_OWNER_USER_ID || '').trim();
    const isOperator = !!ownerUserId && !!user_id && user_id === ownerUserId;

    const body = await ctx.req.json().catch(() => null) as (HarnessFlowEventInput & { target_workspace_id?: string }) | null;
    if (!body || typeof body !== 'object') {
      ctx.status(400);
      return ctx.json({
        error: 'request body must be a JSON object',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }

    // Resolve the workspace this event is written to.
    //  - normal caller: their JWT org (existing contract).
    //  - operator overlay: an explicit, operator-OWNED target_workspace_id.
    let targetWorkspaceId = workspace_id;
    if (!workspace_id) {
      const requestedTarget = typeof body.target_workspace_id === 'string' ? body.target_workspace_id.trim() : '';
      if (isOperator && requestedTarget
          && typeof (dal as { operatorOwnsWorkspace?: unknown }).operatorOwnsWorkspace === 'function') {
        const linkedIds = String((ctx.env as { MBP_OWNER_LINKED_USER_IDS?: string })?.MBP_OWNER_LINKED_USER_IDS || '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const owns = await (dal as unknown as {
          operatorOwnsWorkspace: (ids: string[], ws: string) => Promise<boolean>;
        }).operatorOwnsWorkspace([ownerUserId, ...linkedIds], requestedTarget);
        if (!owns) {
          ctx.status(403);
          return ctx.json({
            error: 'operator does not own target_workspace_id',
            code: 'FORBIDDEN',
            request_id: ctx.get('request_id'),
          });
        }
        targetWorkspaceId = requestedTarget;
      } else {
        // Orgless non-operator (or operator with no/owned target) → 403, as before.
        ctx.status(403);
        return ctx.json({
          error: 'JWT missing org_id — personal sessions cannot ingest events',
          code: 'FORBIDDEN',
          request_id: ctx.get('request_id'),
        });
      }
    } else if (!(await authorizeGovernedWrite(ctx, 'event:ingest')).allowed) {
      // In-org caller still gated by the one-core governed gate (flag-off == the prior viewer/client
      // role deny, byte-identical; operator overlay above is orgless-only).
      ctx.status(403);
      return ctx.json({
        error: 'role does not permit event ingestion',
        code: 'FORBIDDEN',
        request_id: ctx.get('request_id'),
      });
    }

    // Required field validation
    const missing: string[] = [];
    if (!body.id || typeof body.id !== 'string' || body.id.length > 128) missing.push('id');
    if (!body.source_tool || !VALID_SOURCE_TOOLS.has(body.source_tool)) missing.push('source_tool');
    if (!body.status || !VALID_STATUSES.has(body.status)) missing.push('status');
    if (!body.summary || typeof body.summary !== 'string' || body.summary.length > 512) missing.push('summary');
    if (!body.occurred_at || typeof body.occurred_at !== 'string') missing.push('occurred_at');

    if (missing.length > 0) {
      ctx.status(400);
      return ctx.json({
        error: `missing or invalid required fields: ${missing.join(', ')}`,
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }

    // SEC-2 (J-W4 260711-I): body + evidence_link were unbounded into TEXT columns (no DB CHECK). Cap
    // them before persist, matching the webhook clip discipline — an authenticated member can no longer
    // store arbitrarily large blobs (the platform 10MB cap is the only prior bound).
    if (typeof body.body === 'string' && body.body.length > 8000) body.body = body.body.slice(0, 8000);
    if (typeof body.evidence_link === 'string' && body.evidence_link.length > 2048) body.evidence_link = body.evidence_link.slice(0, 2048);

    const result = await dal.upsertEvent(targetWorkspaceId, body);
    ctx.status(result.created ? 201 : 200);
    return ctx.json(result);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
