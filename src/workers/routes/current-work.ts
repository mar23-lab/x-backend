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
import type { CurrentWorkParityObservationInput, CurrentWorkParityStatus } from '../dal/current-work-parity-store';

export interface CurrentWorkEnv extends AuthEnv {
  DATABASE_URL: string;
  // Default-OFF: deliberately NOT declared in wrangler.toml ⇒ inert, code-path-identical.
  CURRENT_WORK_PROJECTION_ENABLED?: string;
  // Default-OFF append-only dual-read telemetry. This never switches projection authority.
  CURRENT_WORK_PARITY_OBSERVATIONS_ENABLED?: string;
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
const HASH_RE = /^[a-f0-9]{64}$/;
const PARITY_STATUSES = new Set<CurrentWorkParityStatus>(['match', 'mismatch', 'client_unavailable', 'server_unavailable']);
const PARITY_DIFFERENCE_CODES = new Set([
  'focus_state_mismatch',
  'action_mismatch',
  'counts_mismatch',
  'version_mismatch',
  'freshness_mismatch',
  'client_unavailable',
  'server_unavailable',
]);
const PARITY_INPUT_FIELDS = new Set([
  'server_projection_version', 'client_projection_version',
  'server_current_work_version', 'client_current_work_version',
  'parity_status', 'difference_codes', 'server_state_sha256', 'client_state_sha256',
  'server_item_count', 'client_item_count',
]);

function parityInput(value: unknown): CurrentWorkParityObservationInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !PARITY_INPUT_FIELDS.has(key))) return null;
  const parityStatus = body.parity_status as CurrentWorkParityStatus;
  const differences = Array.isArray(body.difference_codes) ? [...new Set(body.difference_codes)] : null;
  const validCount = (v: unknown) => v === null || (Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 1_000_000);
  const validHash = (v: unknown) => v === null || (typeof v === 'string' && HASH_RE.test(v));
  if (!Number.isInteger(body.server_projection_version) || Number(body.server_projection_version) < 1
    || !Number.isInteger(body.client_projection_version) || Number(body.client_projection_version) < 1
    || typeof body.server_current_work_version !== 'string' || body.server_current_work_version.length > 160
    || typeof body.client_current_work_version !== 'string' || body.client_current_work_version.length > 160
    || !PARITY_STATUSES.has(parityStatus)
    || !differences || differences.length > 20 || differences.some((code) => typeof code !== 'string' || !PARITY_DIFFERENCE_CODES.has(code))
    || !validHash(body.server_state_sha256) || !validHash(body.client_state_sha256)
    || !validCount(body.server_item_count) || !validCount(body.client_item_count)) return null;
  if (parityStatus === 'match' && differences.length > 0) return null;
  if (parityStatus === 'mismatch' && differences.length === 0) return null;
  if (parityStatus === 'match' && body.server_state_sha256 && body.client_state_sha256
    && body.server_state_sha256 !== body.client_state_sha256) return null;
  return {
    server_projection_version: Number(body.server_projection_version),
    client_projection_version: Number(body.client_projection_version),
    server_current_work_version: body.server_current_work_version,
    client_current_work_version: body.client_current_work_version,
    parity_status: parityStatus,
    difference_codes: differences as string[],
    server_state_sha256: body.server_state_sha256 as string | null,
    client_state_sha256: body.client_state_sha256 as string | null,
    server_item_count: body.server_item_count as number | null,
    client_item_count: body.client_item_count as number | null,
  };
}

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

    // Scope is explicit. Omitting project_id means the whole workspace; the server must never infer
    // "the first project" because project ordering is not user intent and differs across clients.
    const projectId = ctx.req.query('project_id') || null;

    // 260805 · ASK FOR WHAT NEEDS A HUMAN — do not page by recency and filter afterwards.
    //
    // This used to read ONE page of the 200 most recent events and filter it in JS. Measured on
    // production, workspace org_3EG82… holds 3,436 top-level events, 10 of them pending, and only
    // ONE inside that window — worst pending rank 1,621. Nine approvals were invisible, and because
    // the survivor count was 1 the card asserted "1 item needs you": a CONFIDENT WRONG COUNT, which
    // is worse than an empty state. The client shares the identical bug, so the parity shadow
    // compares two copies of it and reports "parity OK".
    //
    // Raising the limit only moves the cliff. The predicate belongs in SQL, next to the ORDER BY.
    const [composite, page] = await Promise.all([
      // The customer UI renders visible operation events plus task packets that are not already
      // represented by a visible event. The server projection must aggregate that same canonical
      // set, not just operation_events, or the Current Work card and activity rail disagree.
      dal.getCurrentWorkComposite(workspaceId, { role: auth.role, project_id: projectId }),
      dal.listEvents(workspaceId, {
        role: auth.role, limit: 200, top_level: true, attention_only: true,
        project_id: projectId ?? undefined,
      }).catch((err) => {
      // FALSE-ZERO DISCLOSURE (260806): a failed attention read otherwise drives the focus card
      // evidence count to zero. The canonical focus/count projection above remains authoritative;
      // this degraded page is used only for the coarse evidence count.
      console.log(JSON.stringify({ kind: 'degraded_read_disclosed', surface: 'current_work_attention_page', error: String((err as Error)?.message || err).slice(0, 160) }));
      return { events: [], pagination: { has_more: false, next_before: null } };
      }),
    ]);
    const events = page.events;
    const totals = composite.counts;

    // The single focal item + its plain-language primary action (mirrors the frontend H2 state machine).
    let focus: null | { event_id: string; packet_id: string | null; intent_id: string | null; project_id: string | null; title: string; state: string; status_label: string; next: string; primary_action: { code: string; label: string } | null } = null;
    const focalItem = composite.focus;
    if (totals.needs_you === 1 && focalItem?.state === 'needs_review') {
      focus = { event_id: focalItem.object_type === 'event' ? focalItem.id : '', packet_id: focalItem.object_type === 'packet' ? focalItem.id : null, intent_id: focalItem.intent_id, project_id: focalItem.project_id, title: clean(focalItem.title), state: 'needs_review', status_label: 'Waiting for your approval', next: 'Review it and record your sign-off', primary_action: { code: 'review_result', label: 'Review now' } };
    } else if (totals.needs_you > 1 && focalItem) {
      focus = { event_id: focalItem.object_type === 'event' ? focalItem.id : '', packet_id: focalItem.object_type === 'packet' ? focalItem.id : null, intent_id: focalItem.intent_id, project_id: focalItem.project_id, title: totals.needs_you + ' items are waiting on you', state: 'needs_review', status_label: 'Waiting for your approval', next: 'Open the review queue', primary_action: { code: 'open_queue', label: 'Open queue' } };
    } else if (totals.blocked >= 1 && focalItem?.state === 'blocked') {
      focus = { event_id: focalItem.object_type === 'event' ? focalItem.id : '', packet_id: focalItem.object_type === 'packet' ? focalItem.id : null, intent_id: focalItem.intent_id, project_id: focalItem.project_id, title: clean(focalItem.title), state: 'blocked', status_label: 'Blocked', next: 'Resolve the blocker to continue', primary_action: { code: 'resolve_blocker', label: 'Resolve' } };
    } else {
      focus = { event_id: '', packet_id: null, intent_id: null, project_id: projectId, title: 'No work is waiting on you', state: 'all_clear', status_label: 'All clear', next: 'Describe the outcome you want', primary_action: null };
    }

    // `events` is now the ATTENTION page, so its length is not a workspace total — see `totals`.
    // Kept only for the parity payload below, which compares like for like with the client.
    const total = totals.total;
    const generatedAt = new Date().toISOString();
    const sourceWatermark = composite.source_watermark;
    const receiptObservation = await dal.countGovernedExecutionReceipts(workspaceId)
      .then((count) => ({ count, status: 'observed' as const }))
      .catch(() => ({ count: null, status: 'unavailable' as const }));
    const payload = {
      schema_id: 'xlooop.current_work_projection.v2',
      projection_version: 2,
      generated_at: generatedAt,
      workspace_id: workspaceId,
      project_id: projectId,
      current_work_version: sourceWatermark || 'empty',
      source_watermark: sourceWatermark,
      freshness: {
        status: sourceWatermark ? 'live' : (events.length ? 'unobservable' : 'empty'),
        generated_at: generatedAt,
        source_updated_at: sourceWatermark,
      },
      // canonical, coarse, counts-only (customer-safe doctrine: never evidence ids, never engine chains)
      focus: focus ? {
        ...focus,
        focus_id: focus.event_id || focus.packet_id || null,
        object_type: focus.event_id ? 'event' : focus.packet_id ? 'packet' : 'none',
        lifecycle: focus.state,
        version: null,
        version_status: 'not_available_from_event_projection',
        target: { type: focus.event_id ? 'event' : focus.packet_id ? 'packet' : 'none', id: focus.event_id || focus.packet_id || null, label: focus.title },
        action: focus.primary_action,
        blocked_reason: focus.state === 'blocked' ? focus.title : null,
        review_state: focus.state === 'needs_review' ? 'requested' : focus.state === 'all_clear' ? 'not_required' : 'none',
      } : null,
      // WHOLE-WORKSPACE counts from the SQL aggregate. `pending.length` here would be the size of
      // the attention page, which is complete today but would silently cap again at scale — the
      // exact failure being fixed. Take counts from the counter.
      counts: {
        needs_you: totals.needs_you,
        blocked: totals.blocked,
        done: totals.done,
        total: totals.total,
        done_pct: totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0,
      },
      // evidence is a COUNT, never ids
      evidence_count: events.filter((e) => Boolean(e.evidence_link)).length,
      receipt_count: receiptObservation.count,
      receipt_count_status: receiptObservation.status,
    };

    return ctx.json(withDataClass(withAuthority(payload, auth, 'current_work'), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

currentWorkRoute.post('/current-work/parity-observations', async (ctx) => {
  try {
    if (!envFlagTrue(ctx.env.CURRENT_WORK_PARITY_OBSERVATIONS_ENABLED)) {
      ctx.status(404);
      return ctx.json({ error: 'current-work parity observations are not enabled', code: 'FEATURE_DISABLED', request_id: ctx.get('request_id') });
    }
    const input = parityInput(await ctx.req.json().catch(() => null));
    if (!input) {
      ctx.status(400);
      return ctx.json({ error: 'invalid customer-safe parity observation', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') });
    }
    const auth = ctx.get('auth');
    const observation = await ctx.get('dal').createCurrentWorkParityObservation(auth.workspace_id, auth.user_id, input);
    ctx.status(202);
    return ctx.json({ accepted: true, observation_id: observation.id, created_at: observation.created_at });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
