// sign-offs.ts · POST /api/v1/sign-offs
//
// Authority: API_CONTRACT_V1.md §POST /api/v1/sign-offs

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { lineageFor } from '../lib/actor-lineage';
import { authorizeGovernedWrite } from '../lib/spine-authority';
import { idempotencyMiddleware } from '../lib/idempotency';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { resolveScopedWorkspace } from '../lib/operator-workspace-scope'; // JB 260714 · write-path operator-workspace-scope
import type { SignOffInput, SignOffVerdict } from '../dal/types';
import { postApprovedDigest } from '../services/agent-digest';
import { emitEvent } from '../lib/observability'; // T3/P6
import type { NotifierEnv } from '../services/email-notifier';

export interface SignOffsEnv extends AuthEnv, NotifierEnv {
  DATABASE_URL: string;
  IDEMPOTENCY_ENABLED?: string;
}

export interface SignOffsVariables extends AuthVariables {
  dal: DalAdapter;
}

export const signOffsRoute = new Hono<{
  Bindings: SignOffsEnv;
  Variables: SignOffsVariables;
}>();

signOffsRoute.use('*', idempotencyMiddleware()); // Wave-Y: flag-off ⇒ passthrough

const VALID_VERDICTS: ReadonlySet<SignOffVerdict> = new Set(['approved', 'rejected', 'noted']);

signOffsRoute.post('/sign-offs', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const { workspace_id: authWs, user_id, role } = auth;
    if (!(await authorizeGovernedWrite(ctx, 'signoff:decide')).allowed) {
      ctx.status(403);
      return ctx.json({
        error: 'role does not permit sign-offs',
        code: 'FORBIDDEN',
        request_id: ctx.get('request_id'),
      });
    }

    const body = (await ctx.req.json().catch(() => null)) as SignOffInput | null;
    if (!body || typeof body !== 'object') {
      ctx.status(400);
      return ctx.json({
        error: 'request body must be a JSON object',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }

    if (!body.event_id || typeof body.event_id !== 'string') {
      ctx.status(400);
      return ctx.json({
        error: 'event_id is required',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    if (!body.verdict || !VALID_VERDICTS.has(body.verdict)) {
      ctx.status(400);
      return ctx.json({
        error: 'verdict must be one of: approved, rejected, noted',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    if (body.comment && (typeof body.comment !== 'string' || body.comment.length > 2000)) {
      ctx.status(400);
      return ctx.json({
        error: 'comment must be a string ≤ 2000 chars',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    const decisionKind = body.decision_kind
      ?? (body.verdict === 'approved' ? 'approval' : body.verdict === 'rejected' ? 'rejection' : null);
    if (decisionKind && !['approval', 'rejection', 'request_changes'].includes(decisionKind)) {
      ctx.status(400);
      return ctx.json({
        error: 'decision_kind must be one of: approval, rejection, request_changes',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }
    if (decisionKind === 'request_changes' && (body.verdict !== 'noted' || !body.comment?.trim())) {
      ctx.status(400);
      return ctx.json({
        error: 'request_changes requires verdict=noted and a non-empty comment',
        code: 'VALIDATION_ERROR',
        request_id: ctx.get('request_id'),
      });
    }

    const dal = ctx.get('dal');
    // JB (260714) · operator-workspace-scope for WRITES (owner-gated). Flag OFF ⇒ authWs unconditionally
    // (byte-identical). Flag ON ⇒ the workspace OWNER signs off in a workspace they own via body.workspace_id;
    // createSignOff's own tenant guard then proves event_id ∈ the resolved workspace (a cross-workspace
    // event mismatch still fails safe). A non-owner override is a hard 403.
    const wsScoped = await resolveScopedWorkspace(
      ctx as never,
      (ctx.env as { OPERATOR_WORKSPACE_SCOPE_ENABLED?: string }).OPERATOR_WORKSPACE_SCOPE_ENABLED,
      authWs,
      user_id,
      typeof (body as { workspace_id?: unknown }).workspace_id === 'string' ? (body as { workspace_id?: string }).workspace_id! : null,
      dal,
      true,
    );
    if (!wsScoped.ok) return wsScoped.res;
    const workspace_id = wsScoped.ws;
    const signOff = await dal.createSignOff(workspace_id, user_id, body);
    emitEvent('signoff_decided', { workspace_id, sign_off_id: (signOff as unknown as { id?: number | string })?.id ?? null, verdict: (body as { verdict?: string })?.verdict ?? null }); // T3/P6
    // ARCH-006 W1.2 — tiered provenance: record the sign-off as a first-class OPERATION-tier event so the
    // chief-of-staff sees the operator's decision (an approve clears a needs-review; a reject keeps it
    // open). `caused_by` lineage (W2.3) stamps audit_logs.causation_id → the signed event. createSignOff's
    // own tenant guard proves event_id belongs to workspace_id, so this mirror is correctly scoped.
    // Best-effort + idempotent (deterministic id): a failed mirror NEVER blocks the sign-off.
    try {
      const rawId = (signOff && typeof signOff === 'object') ? (signOff as { id?: number | string }).id : undefined;
      const soId = (rawId !== undefined && rawId !== null) ? String(rawId) : body.event_id;
      await dal.upsertEvent(workspace_id, {
        id: `evt_signoff_${soId}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
        source_tool: 'xlooop',
        agent_id: 'xlooop:operator-action',
        status: body.verdict === 'rejected' || decisionKind === 'request_changes' ? 'needs_review' : 'completed',
        summary: `[sign-off ${decisionKind || body.verdict}] ${body.event_id}`.slice(0, 512),
        body: typeof body.comment === 'string' ? body.comment.slice(0, 400) : null,
        visibility: 'internal_workspace',
        occurred_at: new Date().toISOString(),
        // A-W4/P6 · the sign-off IS the authorization moment: the human approver is the principal,
        // acting directly (instrument human) under their workspace role authority.
        ...lineageFor(auth),
        request_id: ctx.get('request_id'),
      });
    } catch (err) {
      // best-effort operator-action mirror — never block the sign-off, but LOG it (audit loss must be visible, not silent).
      console.warn('[sign-offs] sign-off audit mirror failed (best-effort)', { workspace_id, error: (err as Error)?.message });
    }
    // OS-5 W2 — the approve_to_post_digest CONSUMER (J2's missing last step). When an approve
    // lands on a digest proposal: atomic claim needs_review→completed (run-exactly-once; ALSO
    // unblocks the weekly sweep, whose idempotency scan counted the approved-but-needs_review
    // proposal as pending forever) + an appended posted-receipt threaded under the proposal +
    // a best-effort email. createSignOff's tenant guard has already proven event_id ∈
    // workspace_id. Best-effort by construction: postApprovedDigest never throws, and a
    // non-digest event no-ops inside it.
    if (body.verdict === 'approved') {
      try {
        await postApprovedDigest(dal, ctx.env, workspace_id, body.event_id, () => new Date());
      } catch (_) { /* delivery must never block the sign-off */ }
    }
    ctx.status(201);
    const signOffId = String((signOff as unknown as { id?: number | string }).id ?? 'unknown');
    return ctx.json({
      ...signOff,
      receipt_id: `signoff:${signOffId}`,
      receipt: {
        schema_id: 'xlooop.signoff_receipt.v1',
        id: `signoff:${signOffId}`,
        sign_off_id: signOffId,
        event_id: body.event_id,
        workspace_id,
        actor_user_id: user_id,
        verdict: body.verdict,
        decision_kind: decisionKind || body.verdict,
        recorded_at: (signOff as unknown as { signed_at?: string }).signed_at || new Date().toISOString(),
        request_id: ctx.get('request_id'),
      },
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
