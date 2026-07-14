import { customerSafeJson, json, validateAccessJwt } from './customer-feedback-authority.js';

export const ALLOWED_ACTIONS = [
  'feedback.resolve',
  'proposal.approve',
  'proposal.reject',
  'telemetry.company.aggregate.read',
  'document.markdown.writeback.request',
  'document.markdown.writeback.apply',
];

const ACTION_STATUSES = new Set([
  'proposed',
  'approved',
  'denied',
  'executing',
  'executed',
  'failed',
  'rolled_back',
  'superseded',
]);

// Resolve the principal identity from a verified CF Access JWT payload.
// CF Access carries the principal differently by credential type:
//   - human SSO sessions → `email`
//   - some configurations → `sub`
//   - service tokens      → `common_name` (the full Client ID; `sub` is empty and
//                            there is no `email` claim)
// The paid-pilot resolver must accept all three, otherwise headless service-token
// evidence capture (the strict-paid-pilot smoke check, which authenticates via a
// CF Access service token) can never resolve an identity and fails closed with
// `access_jwt_email_missing` regardless of what is seeded in D1. This mirrors the
// service-token handling already present in customer-feedback-authority.js.
export function pickAccessIdentityEmail(payload, max = 180) {
  if (!payload || typeof payload !== 'object') return '';
  const raw = payload.email || payload.sub || payload.common_name || '';
  return safeText(raw, max).toLowerCase();
}

export async function requirePaidPilotPrincipal(env, request, options = {}) {
  if (!env.FEEDBACK_DB) return { ok: false, status: 503, error: 'FEEDBACK_DB binding required for paid-pilot authority' };
  const identity = await resolveSignedAccessIdentity(env, request);
  if (!identity.ok) {
    await audit(env, 'auth_denied', { reason: identity.error });
    return { ok: false, status: 401, error: 'signed Cloudflare Access JWT required', detail: identity.error };
  }
  const principal = await readPrincipal(env, identity.email, identity);
  if (!principal) {
    await audit(env, 'tenant_denied', { reason: 'identity_not_registered', email: identity.email });
    return { ok: false, status: 403, error: 'paid-pilot identity is not entitled' };
  }
  const appId = options.appId || 'xlooop';
  const entitlement = principal.app_entitlements.find((entry) => entry.app_id === appId);
  if (!entitlement || entitlement.status !== 'active') {
    await audit(env, 'tenant_denied', {
      reason: 'app_entitlement_denied',
      app_id: appId,
      identity_id: principal.identity_id,
      tenant_id: principal.tenant_id,
    });
    return { ok: false, status: 403, error: `${appId} entitlement required` };
  }
  if (options.mode && !entitlement.allowed_modes.includes(options.mode)) {
    await audit(env, 'action_denied', {
      reason: 'mode_denied',
      mode: options.mode,
      identity_id: principal.identity_id,
      tenant_id: principal.tenant_id,
    });
    return { ok: false, status: 403, error: `${options.mode} mode is not permitted` };
  }
  return { ok: true, principal, entitlement, identity };
}

export async function proposeAction(env, principal, body) {
  const actionType = safeText(body?.action_type || body?.action_id, 160);
  if (!ALLOWED_ACTIONS.includes(actionType)) {
    return denyAction(env, principal, actionType, 'action_not_allowed', body);
  }
  const now = new Date().toISOString();
  const action = baseAction(principal, body, {
    action_type: actionType,
    requested_mode: safeText(body?.requested_mode || 'test', 32),
    policy_decision: 'proposal_created',
    status: 'proposed',
    proposal_id: safeText(body?.proposal_id, 140) || `proposal-${crypto.randomUUID()}`,
    created_at: now,
    updated_at: now,
  });
  await insertAction(env, action);
  await audit(env, 'proposal_created', { tenant_id: principal.tenant_id, identity_id: principal.identity_id, action_id: action.action_id, action_type: action.action_type });
  return { ok: true, action };
}

export async function approveAction(env, principal, body) {
  const actionType = safeText(body?.action_type || body?.action_id || 'proposal.approve', 160);
  const policy = await evaluateActionPolicy(env, principal, actionType, { mode: 'operator', requireApproval: false });
  if (!policy.ok) return denyAction(env, principal, actionType, policy.reason, body);
  const now = new Date().toISOString();
  const action = baseAction(principal, body, {
    action_type: actionType,
    requested_mode: 'operator',
    policy_decision: 'approved',
    status: 'approved',
    approval_id: safeText(body?.approval_id, 140) || `approval-${crypto.randomUUID()}`,
    receipt_id: safeText(body?.receipt_id, 140) || `receipt-${crypto.randomUUID()}`,
    created_at: now,
    updated_at: now,
  });
  await insertAction(env, action);
  await audit(env, 'action_approved', { tenant_id: principal.tenant_id, identity_id: principal.identity_id, action_id: action.action_id, action_type: action.action_type });
  return { ok: true, action };
}

export async function executeAction(env, principal, body) {
  const actionType = safeText(body?.action_type || body?.action_id, 160);
  const policy = await evaluateActionPolicy(env, principal, actionType, { mode: 'operator', requireApproval: true });
  if (!policy.ok) return denyAction(env, principal, actionType, policy.reason, body);
  const idempotencyKey = safeText(body?.idempotency_key, 180);
  if (!idempotencyKey) return denyAction(env, principal, actionType, 'idempotency_key_required', body);
  const existing = await findByIdempotency(env, principal.tenant_id, actionType, idempotencyKey);
  if (existing) return { ok: true, action: existing, replayed: true };
  if (policy.approval_required && !safeText(body?.approval_id, 140)) {
    return denyAction(env, principal, actionType, 'approval_required', body);
  }
  const now = new Date().toISOString();
  const action = baseAction(principal, body, {
    action_type: actionType,
    requested_mode: 'operator',
    policy_decision: 'executed',
    status: 'executed',
    idempotency_key: idempotencyKey,
    receipt_id: safeText(body?.receipt_id, 140) || `receipt-${crypto.randomUUID()}`,
    verifier_ref: safeText(body?.verifier_ref, 240),
    rollback_ref: safeText(body?.rollback_ref, 240),
    created_at: now,
    updated_at: now,
  });
  if (actionType === 'document.markdown.writeback.apply' && (!action.verifier_ref || !action.rollback_ref)) {
    return denyAction(env, principal, actionType, 'verifier_and_rollback_required', body);
  }
  await insertAction(env, action);
  await audit(env, 'action_executed', { tenant_id: principal.tenant_id, identity_id: principal.identity_id, action_id: action.action_id, action_type: action.action_type });
  return { ok: true, action };
}

export async function rollbackAction(env, principal, body) {
  const targetActionId = safeText(body?.action_id, 140);
  if (!targetActionId) return { ok: false, status: 400, error: 'action_id is required' };
  const existing = await readAction(env, targetActionId);
  if (!existing || existing.tenant_id !== principal.tenant_id) {
    await audit(env, 'action_denied', { tenant_id: principal.tenant_id, identity_id: principal.identity_id, reason: 'rollback_target_not_found', action_id: targetActionId });
    return { ok: false, status: 404, error: 'action not found' };
  }
  const now = new Date().toISOString();
  const rollback = {
    ...existing,
    action_id: `rollback-${crypto.randomUUID()}`,
    action_type: `${existing.action_type}.rollback`,
    policy_decision: 'rolled_back',
    status: 'rolled_back',
    rollback_ref: safeText(body?.rollback_ref, 240) || `rollback:${targetActionId}`,
    receipt_id: safeText(body?.receipt_id, 140) || `receipt-${crypto.randomUUID()}`,
    request_json: JSON.stringify(redactObject(body || {})),
    response_json: '{}',
    created_at: now,
    updated_at: now,
  };
  await insertAction(env, rollback);
  await audit(env, 'rollback_created', { tenant_id: principal.tenant_id, identity_id: principal.identity_id, action_id: rollback.action_id, target_action_id: targetActionId });
  return { ok: true, action: rollback };
}

export async function readActionForPrincipal(env, principal, actionId) {
  const row = await readAction(env, actionId);
  if (!row || row.tenant_id !== principal.tenant_id) return null;
  return row;
}

export async function recordSourceWritebackReceipt(env, row) {
  const now = new Date().toISOString();
  await env.FEEDBACK_DB.prepare(
    `insert into paid_pilot_source_writeback_receipts (
      receipt_id, action_id, tenant_id, identity_id, source_repo, source_path, source_kind,
      before_hash, after_hash, patch_hash, approval_ref, commit_ref, verifier_ref, rollback_ref,
      collaboration_claim_id, status, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.receipt_id,
    row.action_id,
    row.tenant_id,
    row.identity_id,
    row.source_repo,
    row.source_path,
    row.source_kind,
    row.before_hash,
    row.after_hash,
    row.patch_hash,
    row.approval_ref,
    row.commit_ref,
    row.verifier_ref,
    row.rollback_ref,
    row.collaboration_claim_id,
    row.status,
    row.created_at || now,
    row.updated_at || now,
  ).run();
  await audit(env, 'source_writeback_receipt_created', { tenant_id: row.tenant_id, identity_id: row.identity_id, action_id: row.action_id, receipt_id: row.receipt_id });
}

export { customerSafeJson, json };

async function resolveSignedAccessIdentity(env, request) {
  if (!truthy(env.CLOUDFLARE_ACCESS_VERIFY_SIGNATURE || env.CF_ACCESS_VERIFY_SIGNATURE)) {
    return { ok: false, error: 'signature_verification_required' };
  }
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') || request.headers.get('CF-Access-Jwt-Assertion');
  if (!jwt) return { ok: false, error: 'missing_cf_access_jwt_assertion' };
  const result = await validateAccessJwt(env, jwt);
  if (!result.ok) return { ok: false, error: result.error || 'invalid_access_jwt' };
  if (!result.signature_verified) return { ok: false, error: 'access_jwt_signature_not_verified' };
  const email = pickAccessIdentityEmail(result.payload);
  if (!email) return { ok: false, error: 'access_jwt_email_missing' };
  return {
    ok: true,
    email,
    subject: safeText(result.payload.sub || '', 180),
    jwt_checked: true,
    signature_verified: true,
  };
}

async function readPrincipal(env, email, identity) {
  const identityRow = await env.FEEDBACK_DB.prepare(
    `select identity_id, email, display_name, principal_kind, status
     from paid_pilot_identities
     where lower(email) = lower(?) and status = 'active'`
  ).bind(email).first();
  if (!identityRow) return null;
  const memberships = await env.FEEDBACK_DB.prepare(
    `select tenant_id, owner_graph_id, workspace_id, roles_json, permissions_json, telemetry_scopes_json, status
     from paid_pilot_tenant_memberships
     where identity_id = ? and status = 'active'`
  ).bind(identityRow.identity_id).all();
  const entitlements = await env.FEEDBACK_DB.prepare(
    `select app_id, status, enabled_by, authority_ref, risk_lane, expires_at, review_due,
      allowed_modes_json, allowed_actions_json, denied_actions_json
     from paid_pilot_app_entitlements
     where identity_id = ?`
  ).bind(identityRow.identity_id).all();
  const membershipRows = (memberships.results || []).map((row) => ({
    tenant_id: row.tenant_id,
    owner_graph_id: row.owner_graph_id,
    workspace_id: row.workspace_id,
    roles: parseList(row.roles_json),
    permissions: parseList(row.permissions_json),
    telemetry_scopes: parseList(row.telemetry_scopes_json),
    status: row.status,
  }));
  if (!membershipRows.length) return null;
  const entitlementRows = normalizeEntitlements(entitlements.results || []);
  if (!entitlementRows.some((row) => row.app_id === 'xcp')) {
    entitlementRows.push({
      app_id: 'xcp',
      status: 'disabled',
      enabled_by: null,
      authority_ref: null,
      risk_lane: 'paid_pilot_default_deny',
      expires_at: null,
      review_due: null,
      allowed_modes: [],
      allowed_actions: [],
      denied_actions: ['xcp:enter'],
    });
  }
  const permissions = unique(membershipRows.flatMap((row) => row.permissions));
  const telemetryScopes = unique(membershipRows.flatMap((row) => row.telemetry_scopes));
  return {
    schema_version: 'xlooop.paid_pilot_principal.v1',
    identity_id: identityRow.identity_id,
    actor_id: `actor:${identityRow.identity_id.replace(/^identity:/, '')}`,
    email: identityRow.email,
    display_name: identityRow.display_name || identityRow.email.split('@')[0],
    principal_kind: identityRow.principal_kind,
    identity_source: 'cloudflare_access',
    assurance_level: identity.signature_verified ? 'cloudflare_access_jwt_signature_verified' : 'cloudflare_access_jwt_claim_checked',
    tenant_id: membershipRows[0].tenant_id,
    owner_graph_id: membershipRows[0].owner_graph_id,
    memberships: membershipRows,
    app_entitlements: entitlementRows,
    permissions,
    telemetry_scopes: telemetryScopes,
    session_issued_at: new Date().toISOString(),
    session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

async function evaluateActionPolicy(env, principal, actionType, options) {
  if (!ALLOWED_ACTIONS.includes(actionType)) return { ok: false, reason: 'action_not_allowed' };
  const entitlement = principal.app_entitlements.find((entry) => entry.app_id === 'xlooop');
  if (!entitlement || entitlement.status !== 'active') return { ok: false, reason: 'xlooop_entitlement_required' };
  if (options.mode && !entitlement.allowed_modes.includes(options.mode)) return { ok: false, reason: 'operator_mode_denied' };
  if (!entitlement.allowed_actions.includes(actionType)) return { ok: false, reason: 'action_not_entitled' };
  const policy = await env.FEEDBACK_DB.prepare(
    `select action_type, status, required_mode, required_permission, approval_required, receipt_policy
     from paid_pilot_action_policies where action_type = ?`
  ).bind(actionType).first();
  if (!policy || policy.status !== 'active') return { ok: false, reason: 'action_policy_missing_or_disabled' };
  if (policy.required_permission && !principal.permissions.includes(policy.required_permission)) return { ok: false, reason: 'permission_denied' };
  return {
    ok: true,
    action_type: actionType,
    required_mode: policy.required_mode,
    required_permission: policy.required_permission,
    approval_required: Boolean(policy.approval_required) && options.requireApproval !== false,
    receipt_policy: policy.receipt_policy,
  };
}

function baseAction(principal, body, values) {
  return {
    action_id: safeText(body?.new_action_id || body?.action_record_id, 140) || `action-${crypto.randomUUID()}`,
    tenant_id: principal.tenant_id,
    identity_id: principal.identity_id,
    actor_id: principal.actor_id,
    action_type: values.action_type,
    target_ref: safeText(body?.target_ref, 240),
    graph_path: safeGraphPath(body?.graph_path),
    requested_mode: values.requested_mode,
    policy_decision: values.policy_decision,
    status: values.status,
    idempotency_key: values.idempotency_key || null,
    proposal_id: values.proposal_id || safeText(body?.proposal_id, 140),
    approval_id: values.approval_id || safeText(body?.approval_id, 140),
    receipt_id: values.receipt_id || safeText(body?.receipt_id, 140),
    verifier_ref: values.verifier_ref || safeText(body?.verifier_ref, 240),
    rollback_ref: values.rollback_ref || safeText(body?.rollback_ref, 240),
    request_json: JSON.stringify(redactObject(body || {})),
    response_json: '{}',
    created_at: values.created_at,
    updated_at: values.updated_at,
  };
}

async function denyAction(env, principal, actionType, reason, body) {
  const now = new Date().toISOString();
  const action = baseAction(principal, body || {}, {
    action_type: actionType || 'unknown',
    requested_mode: safeText(body?.requested_mode || 'operator', 32),
    policy_decision: reason,
    status: ACTION_STATUSES.has('denied') ? 'denied' : 'failed',
    created_at: now,
    updated_at: now,
  });
  await insertAction(env, action).catch(() => {});
  await audit(env, 'action_denied', { tenant_id: principal.tenant_id, identity_id: principal.identity_id, action_id: action.action_id, action_type: action.action_type, reason });
  return { ok: false, status: 403, error: reason, action };
}

async function insertAction(env, row) {
  await env.FEEDBACK_DB.prepare(
    `insert into paid_pilot_actions (
      action_id, tenant_id, identity_id, actor_id, action_type, target_ref, graph_path,
      requested_mode, policy_decision, status, idempotency_key, proposal_id, approval_id,
      receipt_id, verifier_ref, rollback_ref, request_json, response_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.action_id,
    row.tenant_id,
    row.identity_id,
    row.actor_id,
    row.action_type,
    row.target_ref,
    row.graph_path,
    row.requested_mode,
    row.policy_decision,
    row.status,
    row.idempotency_key,
    row.proposal_id,
    row.approval_id,
    row.receipt_id,
    row.verifier_ref,
    row.rollback_ref,
    row.request_json,
    row.response_json,
    row.created_at,
    row.updated_at,
  ).run();
}

async function findByIdempotency(env, tenantId, actionType, idempotencyKey) {
  return env.FEEDBACK_DB.prepare(
    `select * from paid_pilot_actions where tenant_id = ? and action_type = ? and idempotency_key = ?`
  ).bind(tenantId, actionType, idempotencyKey).first();
}

async function readAction(env, actionId) {
  return env.FEEDBACK_DB.prepare(`select * from paid_pilot_actions where action_id = ?`).bind(actionId).first();
}

export async function audit(env, eventType, detail = {}) {
  if (!env.FEEDBACK_DB) return;
  await env.FEEDBACK_DB.prepare(
    `insert into paid_pilot_audit_events (
      event_id, event_type, tenant_id, identity_id, action_id, created_at, severity, detail_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    `event-${crypto.randomUUID()}`,
    safeText(eventType, 80),
    safeText(detail.tenant_id || 'tenant:unknown', 120),
    safeText(detail.identity_id, 140),
    safeText(detail.action_id, 140),
    new Date().toISOString(),
    eventType.endsWith('_denied') || eventType === 'redaction_blocked' ? 'warn' : 'info',
    JSON.stringify(redactObject(detail)),
  ).run();
}

function normalizeEntitlements(rows) {
  return rows.map((row) => ({
    app_id: row.app_id,
    status: row.status || 'disabled',
    enabled_by: row.enabled_by || null,
    authority_ref: row.authority_ref || null,
    risk_lane: row.risk_lane || 'paid_pilot',
    expires_at: row.expires_at || null,
    review_due: row.review_due || null,
    allowed_modes: parseList(row.allowed_modes_json),
    allowed_actions: parseList(row.allowed_actions_json),
    denied_actions: parseList(row.denied_actions_json),
  }));
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => safeText(item, 160)).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((item) => safeText(item, 160)).filter(Boolean);
  } catch {}
  return String(value).split(',').map((item) => safeText(item, 160)).filter(Boolean);
}

function safeGraphPath(value) {
  return String(value || 'workspace/xlooop/domain/paid-pilot/project/current/lane/current/board/actions')
    .split('/')
    .map((part) => safeText(part, 80).toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown')
    .join('/')
    .slice(0, 600);
}

function safeText(value, max = 500) {
  return String(value || '')
    .replace(/\/Users\/[^ \n\t"')]+/g, '[local-path-redacted]')
    .replace(/MB-P\/_sys\/[^ \n\t"')]+/g, '[internal-governance-path-redacted]')
    .replace(/\bHR-[A-Z0-9_-]+\b/g, '[internal-rule-id-redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[secret-redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function redactObject(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item)]));
  }
  return safeText(value, typeof value === 'string' && value.length > 500 ? 4000 : 500);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}
