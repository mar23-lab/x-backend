// plan.ts · G1 (260711) · /api/v1/plan/* — the customer plan facade (writes 1–8).
//
// Authority: BACKEND-CONVERGENCE-BUILDLIST-260711 §G1 · migration 066_plan_entities.sql.
//
// Routes (mounted in the protectedRoutes group = clerkAuth workspace-scoped):
//   GET    /api/v1/plan/:scopeId      → { scope_id, entities:[...] }
//   POST   /api/v1/plan/entity        → 201 { entity }
//   PATCH  /api/v1/plan/entity/:id    → 200 { entity }   (position re-packs siblings)
//   DELETE /api/v1/plan/entity/:id    → 200 { deleted }  (soft-delete + re-pack)
//
// RBAC: workspace member + role != 'client'. Writes use the shared operation-event spine and persist
// strict replay, audit, projection outbox, and canonical readback before returning success.
//
// FLAG: PLAN_ENTITIES_ENABLED (envFlagTrue, default OFF). OFF ⇒ every route returns a clean 404 so the
// surface is INERT until the operator applies migration 066 AND flips the flag — deploying this code
// before then is byte-identical to today. Every write requires Idempotency-Key and schema 93.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { envFlagTrue } from '../lib/env-flag';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { PlanEntityKind, PlanEntityMutationIdempotencyInput, PlanEntityPatch } from '../dal/types';

export interface PlanEnv extends AuthEnv {
  DATABASE_URL: string;
  // Default OFF — the plan surface 404s until the operator applies migration 066 AND flips this.
  PLAN_ENTITIES_ENABLED?: string;
}

export interface PlanVariables extends AuthVariables {
  dal: DalAdapter;
}

export const planRoute = new Hono<{ Bindings: PlanEnv; Variables: PlanVariables }>();

const VALID_KINDS: ReadonlySet<PlanEntityKind> = new Set(['goal', 'milestone', 'todo', 'intent']);

type PlanCtx = Context<{ Bindings: PlanEnv; Variables: PlanVariables }>;

/** Flag gate: a clean 404 when PLAN_ENTITIES_ENABLED is off (surface reads as absent). */
function planDisabledResponse(ctx: PlanCtx): Response | null {
  if (!envFlagTrue((ctx.env as { PLAN_ENTITIES_ENABLED?: string } | undefined)?.PLAN_ENTITIES_ENABLED)) {
    return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'plan surface is not enabled for this deployment yet' });
  }
  return null;
}

/** Resolve the acting workspace member (role != 'client') or return the error Response to send.
 *  Mirrors members.ts fail-closed tenancy: 401 no user · 403 client · 403 no workspace in session. */
function resolveActor(
  ctx: PlanCtx,
): { ok: true; userId: string; workspaceId: string } | { ok: false; res: Response } {
  const auth = ctx.get('auth');
  if (!auth?.user_id) {
    return { ok: false, res: errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' }) };
  }
  if (auth.role === 'client') {
    return { ok: false, res: errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'client role cannot access the plan surface' }) };
  }
  const workspaceId = auth.workspace_id || '';
  if (!workspaceId) {
    return { ok: false, res: errorEnvelope(ctx, { status: 403, code: 'NO_WORKSPACE', message: 'no workspace in session' }) };
  }
  return { ok: true, userId: auth.user_id, workspaceId };
}

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function strictCommand(
  ctx: PlanCtx,
  route: string,
  rawBody: string,
): Promise<PlanEntityMutationIdempotencyInput> {
  const key = String(ctx.req.header('Idempotency-Key') || '').trim();
  if (!key || key.length > 200) {
    throw { status: 428, code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key is required (1-200 chars)' };
  }
  return {
    key,
    route,
    request_sha256: await sha256Text(rawBody),
    request_id: ctx.get('request_id'),
  };
}

// ============================================================
// GET /api/v1/plan/:scopeId
// ============================================================
planRoute.get('/plan/:scopeId', async (ctx) => {
  const off = planDisabledResponse(ctx);
  if (off) return off;
  try {
    const actor = resolveActor(ctx);
    if (!actor.ok) return actor.res;
    const scopeId = ctx.req.param('scopeId');
    if (!scopeId) {
      return errorEnvelope(ctx, { status: 400, code: 'INVALID_SCOPE', message: 'scopeId path param required' });
    }
    const dal = ctx.get('dal');
    const entities = await dal.plan.listPlanEntities(scopeId, { workspaceId: actor.workspaceId });
    return ctx.json(withDataClass({ scope_id: scopeId, entities }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// POST /api/v1/plan/entity
// ============================================================
planRoute.post('/plan/entity', async (ctx) => {
  const off = planDisabledResponse(ctx);
  if (off) return off;
  try {
    const actor = resolveActor(ctx);
    if (!actor.ok) return actor.res;
    const rawBody = await ctx.req.text();
    const body = (() => { try { return JSON.parse(rawBody) as Record<string, unknown>; } catch { return null; } })();
    if (!body || typeof body !== 'object') {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'request body must be a JSON object' });
    }
    const kind = String(body.kind || '');
    if (!VALID_KINDS.has(kind as PlanEntityKind)) {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: `kind must be one of: ${Array.from(VALID_KINDS).join(', ')}` });
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 200) {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'title is required (1-200 chars)' });
    }
    const dal = ctx.get('dal');
    const receipt = await dal.plan.createPlanEntity(
      {
        workspace_id: actor.workspaceId,
        scope_id: typeof body.scope_id === 'string' ? body.scope_id : null,
        scope_type: typeof body.scope_type === 'string' ? body.scope_type : null,
        parent_id: typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null,
        kind: kind as PlanEntityKind,
        title,
        target_date: typeof body.target_date === 'string' ? body.target_date : null,
      },
      actor.userId,
      await strictCommand(ctx, 'POST /api/v1/plan/entity', rawBody),
    );
    if (receipt.replayed) ctx.header('Idempotency-Replayed', 'true');
    return ctx.json(receipt, 201);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// PATCH /api/v1/plan/entity/:id
// ============================================================
planRoute.patch('/plan/entity/:id', async (ctx) => {
  const off = planDisabledResponse(ctx);
  if (off) return off;
  try {
    const actor = resolveActor(ctx);
    if (!actor.ok) return actor.res;
    const id = ctx.req.param('id');
    if (!id) {
      return errorEnvelope(ctx, { status: 400, code: 'INVALID_ID', message: 'id path param required' });
    }
    const rawBody = await ctx.req.text();
    const body = (() => { try { return JSON.parse(rawBody) as Record<string, unknown>; } catch { return null; } })();
    if (!body || typeof body !== 'object') {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'request body must be a JSON object' });
    }
    const patch: PlanEntityPatch = {};
    if (typeof body.title === 'string') patch.title = body.title.trim();
    if (typeof body.status === 'string') patch.status = body.status;
    if (typeof body.position === 'number' && Number.isFinite(body.position)) patch.position = Math.trunc(body.position);
    // parent_id is nullable: an explicit null reparents to top-level, so honour key-presence (not truthiness).
    if (Object.prototype.hasOwnProperty.call(body, 'parent_id')) {
      patch.parent_id = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null;
    }
    if (Object.keys(patch).length === 0) {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'no updatable fields (title, status, position, parent_id)' });
    }
    if (patch.title !== undefined && (!patch.title || patch.title.length > 200)) {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'title must be 1-200 chars' });
    }
    if (patch.position !== undefined && patch.position < 0) {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'position must be >= 0' });
    }
    const dal = ctx.get('dal');
    // Tenancy 404: prove the entity is in the caller's workspace before mutating (fail-closed).
    const existing = await dal.plan.getPlanEntity(id, actor.workspaceId);
    if (!existing) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `plan entity ${id} not found` });
    }
    const receipt = await dal.plan.updatePlanEntity(
      existing,
      patch,
      actor.userId,
      await strictCommand(ctx, `PATCH /api/v1/plan/entity/${id}`, rawBody),
    );
    if (receipt.replayed) ctx.header('Idempotency-Replayed', 'true');
    return ctx.json(receipt);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ============================================================
// DELETE /api/v1/plan/entity/:id
// ============================================================
planRoute.delete('/plan/entity/:id', async (ctx) => {
  const off = planDisabledResponse(ctx);
  if (off) return off;
  try {
    const actor = resolveActor(ctx);
    if (!actor.ok) return actor.res;
    const id = ctx.req.param('id');
    if (!id) {
      return errorEnvelope(ctx, { status: 400, code: 'INVALID_ID', message: 'id path param required' });
    }
    const dal = ctx.get('dal');
    const existing = await dal.plan.getPlanEntity(id, actor.workspaceId);
    if (!existing) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `plan entity ${id} not found` });
    }
    const receipt = await dal.plan.softDeletePlanEntity(
      existing,
      actor.userId,
      await strictCommand(ctx, `DELETE /api/v1/plan/entity/${id}`, ''),
    );
    if (receipt.replayed) ctx.header('Idempotency-Replayed', 'true');
    return ctx.json(receipt);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
