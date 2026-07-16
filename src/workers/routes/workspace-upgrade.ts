// workspace-upgrade.ts · U4a customer-ecosystem (260708) · the honest "request upgrade" backend.
//
// The new cockpit UI has a "request upgrade" action but there is NO billing system (no Stripe, no tiers,
// no payment). Operator decision (260708): AUDITED REQUEST EVENT + ADMIN NOTIFY — this endpoint does NOT
// process a payment or change any entitlement. It records a durable audited request (audit_logs, action
// 'account_upgrade_requested') and best-effort notifies the admin, who follows up manually. Fully reversible;
// no migration (audit_logs.action is a permissive [a-z_]+ regex, target_type 'workspace' is already allowed).
//
// TENANT-SAFE: the workspace is ONLY ever the verified JWT's; behind the provisioning-entitlement guard.
// Any provisioned member may raise the request (it is a business ask, not a governed write) — the audited row
// records exactly who asked. The audit row is required before the customer sees success; admin notify stays
// best-effort because the durable operator triage record is the audit request itself.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { gateCustomerWorkspace } from '../lib/workspace-gates';
import { notifyAdminAccessRequest, type NotifierEnv } from '../services/email-notifier';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';

export interface WorkspaceUpgradeEnv extends AuthEnv, NotifierEnv {
  DATABASE_URL: string;
}
export interface WorkspaceUpgradeVariables extends AuthVariables {
  dal: DalAdapter;
}

export const workspaceUpgradeRoute = new Hono<{ Bindings: WorkspaceUpgradeEnv; Variables: WorkspaceUpgradeVariables }>();

// POST /api/v1/workspace/upgrade-request  { tier?: string, note?: string }
workspaceUpgradeRoute.post('/workspace/upgrade-request', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    // Provisioning gate — the shared lib/workspace-gates.ts driver (S3; byte-identical responses).
    // No governed overlay: any provisioned member may raise the request (a business ask, not a governed write).
    const gate = await gateCustomerWorkspace(ctx as never);
    if (!gate.ok) return gate.res;
    const ws = gate.ws;
    const dal = gate.dal;

    let body: { tier?: unknown; note?: unknown } = {};
    try { body = (await ctx.req.json()) as typeof body; } catch { body = {}; }
    const tier = typeof body.tier === 'string' && body.tier.trim() ? body.tier.trim().slice(0, 64) : null;
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
    const request_id = `upreq_${crypto.randomUUID()}`;
    const created_at = new Date().toISOString();

    // Durable audited request event — the record an auditor / the operator can act on later. Fail closed:
    // without this row the returned request_id would not point at a durable operator-triable request.
    try {
      await dal.appendAuditLog({
        actor_user_id: auth.user_id,
        action: 'account_upgrade_requested',
        target_type: 'workspace',
        target_id: ws,
        workspace_id: ws,
        reason: note,
        metadata: { request_id, requested_tier: tier, requested_by_email: auth.email ?? null, created_at },
      });
    } catch {
      return errorEnvelope(ctx, { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'upgrade request could not be recorded' });
    }

    // Best-effort admin notify (log + email). Framed as an upgrade via source/reason (returns delivered:false on failure).
    await notifyAdminAccessRequest(ctx.env, {
      request_id,
      email: auth.email ?? 'unknown',
      company_name: null,
      reason: `UPGRADE REQUEST${tier ? ` -> ${tier}` : ''}${note ? `: ${note}` : ''}`,
      source: 'upgrade_request',
      ip_address: null,
      created_at,
      account_type: 'existing_customer',
      registered: true,
    }).catch(() => { /* best-effort */ });

    ctx.status(202);
    return ctx.json(withDataClass({ ok: true, request_id, status: 'received', workspace_id: ws }, 'live'));
  } catch (err) { return errorEnvelope(ctx, err); }
});
