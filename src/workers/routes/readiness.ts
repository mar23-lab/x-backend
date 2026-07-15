// readiness.ts · POST /api/v1/readiness/submit  (M.7 · in-app first-login readiness journey)
//
// A signed-in Clerk-org customer who has NO workspace yet (session state 'needs_readiness',
// gated by CUSTOMER_INAPP_READINESS_GATE in session.ts) completes the in-app readiness
// questionnaire; this endpoint captures the Q&A and provisions their workspace with a day-1
// roadmap SCALED to the answers — instead of the generic (readiness=null) roadmap the Clerk-org
// auto-provision produces. Reuses createAccessRequest + approveAccessRequest +
// createReadinessAssessment + provisionCustomerFromAccessRequest (no new provisioning logic).
//
// WORKSPACE-SCOPED + safe: a caller only ever provisions THEIR OWN org (the same workspace the
// Clerk-org auto-provision would have created) — it can never touch another tenant. Idempotent:
// an already-provisioned caller gets { ok:true, already:true } with no side effects. Harmless
// when the gate flag is off (the session never returns needs_readiness, so the journey — and
// hence this endpoint — is never reached by the UI).

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { envFlagTrue } from '../lib/env-flag';
import { provisionCustomerFromAccessRequest } from '../services/onboarding-provisioner';
import { runEnrichmentSweep } from '../services/enrichment-service';
import { neonClient } from '../db/client';
import { getReadinessAssessmentByWorkspaceRow } from '../dal/customer-readiness-store';
import type { AiRunner } from '../services/agent-digest';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { modelLineagePolicy } from '../lib/model-execution-lineage';

export interface ReadinessEnv extends AuthEnv {
  DATABASE_URL: string;
  CONTEXT_PACKET_PERSISTENCE_ENABLED?: string;
  ROLE_SKILL_CATALOG_ENABLED?: string;
  RESOLUTION_RECEIPT_SIGNING_SECRET?: string;
  RESOLUTION_RECEIPT_SIGNING_KEY_ID?: string;
  XLOOOP_DEPLOY_SHA?: string;
  CUSTOMER_AUTO_PROVISION_APPROVER_USER_ID?: string;
  MBP_OWNER_USER_ID?: string;
  ADMIN_USER_IDS?: string;
  CONTEXT_RESOLVER_ENABLED?: string;
  CUSTOMER_SELF_SERVICE_ENABLED?: string; // P.9 (260628) · gates customer self-service (roadmap re-entry, event soft-delete/restore). Default OFF → ships dormant until operator browser-verify. Parsed via envFlagTrue (quote-tolerant).
  ENRICHMENT_SWEEP_ENABLED?: string; // Wave B (260628) · gates the server-side public-signal sweep on submit. Default OFF → dormant. Free sources (SPF/DMARC/TLS) need no key; paid (HIBP/BuiltWith) activate when their key is present. Parsed via envFlagTrue.
  HIBP_API_KEY?: string;      // Wave B · operator secret. Absent → the HIBP source reports 'not_configured' (honest), never a fabricated result.
  BUILTWITH_API_KEY?: string; // Wave B · operator secret. Absent → the BuiltWith source reports 'not_configured'.
}

export interface ReadinessVariables extends AuthVariables {
  dal: DalAdapter;
}

export const readinessRoute = new Hono<{ Bindings: ReadinessEnv; Variables: ReadinessVariables }>();

const ALLOWED_ACCOUNT_TYPES = new Set(['personal', 'company', 'both']);

// Mirror autoProvisionApprover(session.ts): explicit approver → operator → first admin id.
function readinessApprover(env: ReadinessEnv): string | null {
  const explicit = env.CUSTOMER_AUTO_PROVISION_APPROVER_USER_ID?.trim();
  if (explicit) return explicit;
  const owner = env.MBP_OWNER_USER_ID?.trim();
  if (owner) return owner;
  return (env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).find(Boolean) || null;
}

// Mirror request-access.ts boundedRecord: only plain objects, capped to a sane JSON size.
function boundedRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (JSON.stringify(value).length > 262_144) return null; // S2 (260628) · 256KB — the customer's full context must persist, not silently drop the whole object past 24KB
  } catch {
    return null;
  }
  return value as Record<string, unknown>;
}

readinessRoute.post('/readiness/submit', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const orgId = String(auth.workspace_id || '').trim();
    if (!orgId) {
      return errorEnvelope(ctx, { status: 403, code: 'NO_WORKSPACE', message: 'an organization is required to complete onboarding' });
    }
    const email = String(auth.email || '').trim();
    if (!email) {
      return errorEnvelope(ctx, { status: 400, code: 'NO_EMAIL', message: 'a verified email is required to complete onboarding' });
    }

    const dal = ctx.get('dal');

    const body = (await ctx.req.json().catch(() => ({}))) as Record<string, unknown>;
    // E2 (260628) · Profile roadmap re-entry. A customer re-running the journey to "update my
    // roadmap" sends { reprovision: true }. Gated by CUSTOMER_SELF_SERVICE_ENABLED so the
    // re-entry capability ships dormant (default OFF) until operator browser-verify. When set,
    // skip the already-provisioned short-circuit and re-run provisioning, which refreshes the
    // roadmap from the new answers — status-PRESERVING via F1 (customer-provisioning-store.ts),
    // so a step the customer already marked done is not reverted.
    const reprovision = body.reprovision === true && envFlagTrue(ctx.env.CUSTOMER_SELF_SERVICE_ENABLED);

    // Idempotent: an already-provisioned caller accepts without re-running — UNLESS this is a
    // deliberate, flag-enabled re-entry (reprovision), which refreshes their roadmap.
    const existing = await dal.getSessionEntitlement(auth.user_id, orgId, email);
    if (existing.state === 'approved_workspace' && !reprovision) {
      return ctx.json({ ok: true, state: 'approved_workspace', already: true });
    }

    const approvedBy = readinessApprover(ctx.env);
    if (!approvedBy) {
      return errorEnvelope(ctx, { status: 503, code: 'NO_APPROVER', message: 'onboarding approver is not configured' });
    }

    const accountType =
      typeof body.account_type === 'string' && ALLOWED_ACCOUNT_TYPES.has(body.account_type)
        ? (body.account_type as 'personal' | 'company' | 'both')
        : 'company';
    const companyName =
      typeof body.company_name === 'string' && body.company_name.trim()
        ? body.company_name.trim().slice(0, 200)
        : email.split('@')[1] || 'Your company';

    // 1. Create the access request (records the in-app journey source for audit).
    const accessRequest = await dal.createAccessRequest({
      email,
      company_name: companyName,
      reason: 'In-app first-login readiness journey completed; session-first provisioning.',
      source: 'inapp-readiness-journey',
    });

    // 2. Approve it (operator/system approver — same authority as the Clerk-org path).
    const approved = await dal.approveAccessRequest(accessRequest.id, approvedBy);

    // Wave B (260628) · REAL public-signal enrichment (flag-gated, default OFF → dormant).
    // When enabled, compute the sweep SERVER-SIDE from the domain (best-effort, never throws)
    // and store the REAL result — replacing the frontend's animation metadata. Free sources
    // (SPF/DMARC/TLS) need no key; HIBP/BuiltWith activate when their operator secret is set,
    // else report 'not_configured' honestly. The result feeds buildCustomerContextProfile so
    // the connected AI sees real signals instead of a placebo.
    const domainStr = typeof body.domain === 'string' ? body.domain.slice(0, 253) : null;
    let enrichment = boundedRecord(body.enrichment);
    if (envFlagTrue(ctx.env.ENRICHMENT_SWEEP_ENABLED)) {
      const sweep = await runEnrichmentSweep(domainStr, ctx.env).catch(() => null);
      if (sweep) enrichment = boundedRecord({ ...(enrichment ?? {}), ...sweep });
    }

    // 3. Persist the readiness Q&A — the whole point: this is what scales the roadmap.
    //    Best-effort: a persistence failure must not strand the user; provisioning then
    //    falls back to the base roadmap, exactly as the pre-M.7 flow did.
    try {
      await dal.createReadinessAssessment({
        access_request_id: accessRequest.id,
        email,
        account_type: accountType,
        also_personal_space: body.also_personal_space === true,
        company_name: companyName,
        domain: domainStr,
        country: typeof body.country === 'string' ? body.country.slice(0, 8) : null,
        deep_level:
          typeof body.deep_level === 'number' && Number.isInteger(body.deep_level) ? body.deep_level : null,
        readiness_answers: boundedRecord(body.readiness_answers) ?? {},
        deep_check: boundedRecord(body.deep_check),
        enrichment: enrichment,
        consent: boundedRecord(body.consent) ?? {},
        source: 'inapp-readiness-journey',
      });
    } catch (err) {
      console.log(
        JSON.stringify({
          kind: 'inapp_readiness_persist_error',
          request_id: accessRequest.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // 4. Provision the workspace + day-1 roadmap, now SCALED to the captured readiness.
    const modelLineage = modelLineagePolicy({ load: () => neonClient(ctx.env.DATABASE_URL) }, ctx.env);
    await provisionCustomerFromAccessRequest(
      dal,
      {
        accessRequestId: accessRequest.id,
        clerkOrgId: orgId,
        ownerClerkId: auth.user_id,
        operatorClerkId: null,
        projectName: `${companyName} onboarding`,
        approvedBy: approved.reviewed_by || approvedBy,
        ai: (ctx.env as { AI?: AiRunner }).AI,
        modelLineageFactory: modelLineage.factory,
        modelLineageRequired: modelLineage.required,
      },
      { CONTEXT_RESOLVER_ENABLED: ctx.env.CONTEXT_RESOLVER_ENABLED },
    );

    return ctx.json({ ok: true, state: 'approved_workspace' });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// In-app re-entry pre-fill: return the customer's OWN saved readiness so the "Update my onboarding
// roadmap" journey shows their previous answers instead of a blank form. TENANT-SAFE: keyed on the
// verified-JWT workspace_id ONLY; returns the customer's own Q&A (their data, no cross-tenant read).
readinessRoute.get('/readiness', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const workspaceId = String(auth.workspace_id || '').trim();
    // Read the customer's OWN readiness via the store fn directly — the DAL adapter is FROZEN (S-R1),
    // so we don't add an adapter method; a route constructing a scoped sql client is the existing pattern.
    const ra = workspaceId
      ? await getReadinessAssessmentByWorkspaceRow(neonClient(ctx.env.DATABASE_URL), workspaceId).catch(() => null)
      : null;
    if (!ra) {
      return ctx.json({ schema_id: 'xlooop.readiness_prefill.v1', has_readiness: false });
    }
    const answers = ra.readiness_answers && typeof ra.readiness_answers === 'object'
      ? (ra.readiness_answers as Record<string, unknown>)
      : {};
    return ctx.json({
      schema_id: 'xlooop.readiness_prefill.v1',
      has_readiness: true,
      company_name: ra.company_name ?? null,
      domain: ra.domain ?? null,
      country: ra.country ?? null,
      account_type: ra.account_type ?? null,
      deep_level: ra.deep_level ?? null,
      readiness_answers: answers, // q1..q5, q3_detail, ai_tools, integrations
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
