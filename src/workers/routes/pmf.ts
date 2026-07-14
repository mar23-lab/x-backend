// pmf.ts · PMF (Sean Ellis) survey + DAU/return-rate — the two halves of the
// indispensability launch criterion ("daily-active use + Sean-Ellis ≥40% very-disappointed").
//
//   POST /api/v1/pmf                  · authed · record the caller's response (upsert by user)
//   GET  /api/v1/pmf-summary          · operator-only · the very-disappointed % metric + counts
//   GET  /api/v1/engagement-summary   · operator-only · DAU / active-workspaces / return-rate
//
// "How would you feel if you could no longer use Xlooop?" → % "very disappointed" (>40% = PMF).
// The engagement readout is the OTHER half: is the product in DAILY use? Read-only, derived from
// the existing operation_events timestamps — no migration. Both readouts are operator-gated.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';

export interface PmfEnv extends AuthEnv {
  DATABASE_URL: string;
  MBP_OWNER_USER_ID?: string;
  MBP_OWNER_LINKED_USER_IDS?: string;
}
export interface PmfVariables extends AuthVariables {
  dal: DalAdapter;
}

export const pmfRoute = new Hono<{ Bindings: PmfEnv; Variables: PmfVariables }>();

const VALID_SENTIMENT: ReadonlySet<string> = new Set([
  'very_disappointed', 'somewhat_disappointed', 'not_disappointed',
]);

function isOperator(env: PmfEnv, userId: string): boolean {
  const owner = String(env?.MBP_OWNER_USER_ID || '').trim();
  const linked = String(env?.MBP_OWNER_LINKED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return !!owner && [owner, ...linked].includes(userId);
}

// POST /api/v1/pmf — record the caller's PMF response (authed; one per user, latest wins).
pmfRoute.post('/pmf', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const body = (await ctx.req.json().catch(() => ({}))) as {
      sentiment?: string; benefit?: string; improvement?: string; persona?: string; workspace_id?: string;
    };
    if (!body.sentiment || !VALID_SENTIMENT.has(body.sentiment)) {
      return errorEnvelope(ctx, {
        status: 400, code: 'VALIDATION_ERROR',
        message: `sentiment must be one of: ${Array.from(VALID_SENTIMENT).join(', ')}`,
      });
    }
    const dal = ctx.get('dal');
    const resp = await dal.recordPmfResponse({
      user_id: auth.user_id,
      workspace_id: (body.workspace_id || auth.workspace_id || null) as string | null,
      sentiment: body.sentiment as 'very_disappointed' | 'somewhat_disappointed' | 'not_disappointed',
      benefit: body.benefit ?? null,
      improvement: body.improvement ?? null,
      persona: body.persona ?? null,
    });
    return ctx.json({ recorded: { id: resp.id, sentiment: resp.sentiment } }, 201);
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
  }
});

// GET /api/v1/pmf-summary — operator-only · the very-disappointed % metric.
pmfRoute.get('/pmf-summary', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    if (!isOperator(ctx.env, auth.user_id)) {
      return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'PMF summary is operator-only' });
    }
    const dal = ctx.get('dal');
    const summary = await dal.getPmfSummary();
    return ctx.json({ summary });
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
  }
});

// GET /api/v1/engagement-summary — operator-only · DAU / active-workspaces / week-over-week
// return rate. The "daily-active use" half of the launch criterion. Read-only; derived from the
// existing operation_events timestamps (no migration). `?window=<7..180>` sets the day range
// (default 28). Same operator gate + envelope as /pmf-summary.
pmfRoute.get('/engagement-summary', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    if (!isOperator(ctx.env, auth.user_id)) {
      return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'engagement summary is operator-only' });
    }
    const windowRaw = parseInt(ctx.req.query('window') || '', 10);
    const windowDays = Number.isFinite(windowRaw) ? windowRaw : undefined;
    const dal = ctx.get('dal');
    const summary = await dal.getEngagementRollup(windowDays);
    return ctx.json({ summary });
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
  }
});
