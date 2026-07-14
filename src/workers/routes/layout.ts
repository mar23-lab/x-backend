// layout.ts · GET/PUT /api/v1/layout (R52-B1)
//
// Pillar 3 · "restructurable in order — convenient for a user how it is
// visible for it." Persists each operator's chosen ordering / hidden-set /
// custom groupings as a partial OVERLAY over the read-model's default order.
//
// Routes:
//   GET /api/v1/layout   → the authed user's saved layout (or default stub)
//   PUT /api/v1/layout   → upsert the authed user's layout (body = layout JSON)
//
// AUTH: user-scoped (each user owns their own layout). Same auth contract as
// /api/v1/sources.
//
// The layout is intentionally a partial overlay: any absent key (workspace_order,
// project_order, hidden_*, custom_groups) means "use read-model default for
// that dimension." A workspace/project that exists but isn't listed in an
// order array still renders (appended after the ordered ones, client-side).
// This guarantees the layout can never HIDE data the operator didn't explicitly
// hide — a safety property for a reorganize feature.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';

export interface LayoutEnv extends AuthEnv {
  DATABASE_URL: string;
}

export interface LayoutVariables extends AuthVariables {
  dal: DalAdapter;
}

export const layoutRoute = new Hono<{ Bindings: LayoutEnv; Variables: LayoutVariables }>();

// Known top-level keys of the layout overlay (version 1). Unknown keys are
// rejected to keep the stored shape disciplined + forward-auditable.
const ALLOWED_LAYOUT_KEYS = new Set([
  'version',
  'workspace_order',
  'hidden_workspaces',
  'project_order',
  'hidden_projects',
  'custom_groups',
]);

const MAX_LAYOUT_BYTES = 64 * 1024; // generous; one operator's ordering, not data

function validateLayout(body: unknown): { ok: true; layout: Record<string, unknown> } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'layout must be a JSON object' };
  }
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_LAYOUT_KEYS.has(key)) {
      return { ok: false, message: `unknown layout key: ${key}` };
    }
  }
  // Shape checks for the array/map dimensions (all optional).
  for (const arrKey of ['workspace_order', 'hidden_workspaces', 'hidden_projects', 'custom_groups']) {
    if (arrKey in obj && !Array.isArray(obj[arrKey])) {
      return { ok: false, message: `${arrKey} must be an array` };
    }
  }
  if ('project_order' in obj && (typeof obj.project_order !== 'object' || obj.project_order === null || Array.isArray(obj.project_order))) {
    return { ok: false, message: 'project_order must be an object keyed by workspace_id' };
  }
  const size = JSON.stringify(obj).length;
  if (size > MAX_LAYOUT_BYTES) {
    return { ok: false, message: `layout too large (${size} > ${MAX_LAYOUT_BYTES} bytes)` };
  }
  return { ok: true, layout: { version: 1, ...obj } };
}

layoutRoute.get('/layout', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const dal = ctx.get('dal');
    const row = await dal.getOperatorLayout(auth.user_id);
    if (!row) {
      // No saved layout yet → return an empty overlay (cockpit uses defaults).
      return ctx.json({ layout: { version: 1 }, saved: false, updated_at: null });
    }
    return ctx.json({ layout: row.layout, saved: true, updated_at: row.updated_at });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

layoutRoute.put('/layout', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      return errorEnvelope(ctx, { status: 400, code: 'INVALID_BODY', message: 'body must be valid JSON' });
    }
    const verdict = validateLayout(body);
    if (!verdict.ok) {
      return errorEnvelope(ctx, { status: 422, code: 'INVALID_LAYOUT', message: verdict.message });
    }
    const dal = ctx.get('dal');
    const saved = await dal.putOperatorLayout(auth.user_id, verdict.layout);
    return ctx.json({ layout: saved.layout, saved: true, updated_at: saved.updated_at });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
