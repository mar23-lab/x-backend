import { resolveAccessIdentity } from '../_lib/customer-feedback-authority.js';

const ALLOWED_STATUS = new Set(['open', 'triaged', 'linked', 'resolved', 'verified']);
const ALLOWED_CATEGORY = new Set([
  'not_working',
  'unclear',
  'needs_functionality',
  'wrong_data',
  'visual_ui_issue',
  'security_privacy',
]);
const ALLOWED_SEVERITY = new Set(['low', 'medium', 'high', 'critical']);

export async function onRequestGet({ env, request }) {
  if (!env.FEEDBACK_DB) return json({ persisted: false, rows: [], reason: 'FEEDBACK_DB binding missing' }, 202);
  const identity = await getAccessIdentity(env, request);
  if (accessRequired(env) && !hasAccessIdentity(identity)) return json({ error: 'Cloudflare Access identity required' }, 401);
  const url = new URL(request.url);
  const tenantId = safeText(url.searchParams.get('tenant_id') || 'mbp-owner', 80);
  const rows = await env.FEEDBACK_DB.prepare(
    `select feedback_id, tenant_id, environment, user_email, created_at, updated_at, status, category,
      severity, comment, route, workspace_id, domain_id, project_id, lane_id, board_id, graph_path,
      component_id, control_id, action_id, target_label, receipt_id
     from feedback_annotations
     where tenant_id = ?
     order by created_at desc
     limit 100`
  ).bind(tenantId).all();
  return json({ persisted: true, identity, rows: rows.results || [] });
}

export async function onRequestPost({ env, request }) {
  const body = await request.json().catch(() => null);
  const validation = validateFeedback(body);
  if (!validation.ok) return json({ error: validation.error }, 400);
  const row = validation.row;
  const identity = await getAccessIdentity(env, request);
  if (env.FEEDBACK_DB && accessRequired(env) && !hasAccessIdentity(identity)) return json({ error: 'Cloudflare Access identity required' }, 401);
  if (identity?.email && row.user_email === 'unknown@xlooop.local') row.user_email = identity.email;
  if (!identity?.email && identity?.service_token && row.user_email === 'unknown@xlooop.local') row.user_email = identity.service_token;
  row.receipt_id = row.receipt_id || `feedback-receipt-${row.feedback_id}`;

  if (!env.FEEDBACK_DB) {
    return json({ persisted: false, receipt_id: row.receipt_id, reason: 'FEEDBACK_DB binding missing' }, 202);
  }

  await env.FEEDBACK_DB.prepare(
    `insert into feedback_annotations (
      feedback_id, tenant_id, environment, user_email, created_at, updated_at, status, category, severity,
      comment, route, workspace_id, domain_id, domain_kind, project_id, lane_id, board_id, graph_path,
      component_id, control_id, action_id, target_label, source_adapter, data_provenance, build_sha,
      resolution_ref, receipt_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(feedback_id) do update set
      updated_at=excluded.updated_at,
      status=excluded.status,
      category=excluded.category,
      severity=excluded.severity,
      comment=excluded.comment,
      receipt_id=excluded.receipt_id`
  ).bind(
    row.feedback_id,
    row.tenant_id,
    row.environment,
    row.user_email,
    row.created_at,
    row.updated_at,
    row.status,
    row.category,
    row.severity,
    row.comment,
    row.route,
    row.workspace_id,
    row.domain_id,
    row.domain_kind,
    row.project_id,
    row.lane_id,
    row.board_id,
    row.graph_path,
    row.component_id,
    row.control_id,
    row.action_id,
    row.target_label,
    row.source_adapter,
    row.data_provenance,
    row.build_sha,
    row.resolution_ref,
    row.receipt_id
  ).run();

  return json({ persisted: true, receipt_id: row.receipt_id, status: row.status });
}

export async function onRequestPatch({ env, request }) {
  const body = await request.json().catch(() => null);
  const feedbackId = safeText(body?.feedback_id, 120);
  const status = safeText(body?.status, 24);
  if (!feedbackId || !ALLOWED_STATUS.has(status)) return json({ error: 'Invalid feedback_id or status' }, 400);
  if (!env.FEEDBACK_DB) return json({ persisted: false, reason: 'FEEDBACK_DB binding missing' }, 202);
  const identity = await getAccessIdentity(env, request);
  if (accessRequired(env) && !hasAccessIdentity(identity)) return json({ error: 'Cloudflare Access identity required' }, 401);
  await env.FEEDBACK_DB.prepare(
    `update feedback_annotations set status = ?, updated_at = ? where feedback_id = ?`
  ).bind(status, new Date().toISOString(), feedbackId).run();
  return json({ persisted: true, feedback_id: feedbackId, status });
}

function validateFeedback(body) {
  if (!body || body.schema_version !== 'xlooop.feedback_annotation.v1') return { ok: false, error: 'Invalid schema_version' };
  const comment = safeText(body.comment, 4000);
  if (!comment) return { ok: false, error: 'Comment is required' };
  const blocked = forbiddenContent(comment) || forbiddenContent(body.graph_path) || forbiddenContent(body.route);
  if (blocked) return { ok: false, error: `Forbidden private/internal content: ${blocked}` };
  const row = {
    feedback_id: safeText(body.feedback_id, 120) || crypto.randomUUID(),
    tenant_id: safeText(body.tenant_id, 120) || 'mbp-owner',
    environment: safeText(body.environment, 32) || 'dev',
    user_email: safeText(body.user_email, 180) || 'unknown@xlooop.local',
    created_at: safeText(body.created_at, 64) || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: ALLOWED_STATUS.has(body.status) ? body.status : 'open',
    category: ALLOWED_CATEGORY.has(body.category) ? body.category : 'unclear',
    severity: ALLOWED_SEVERITY.has(body.severity) ? body.severity : 'medium',
    comment,
    route: safeText(body.route, 400),
    workspace_id: safeText(body.workspace_id, 120),
    domain_id: safeText(body.domain_id, 120),
    domain_kind: safeText(body.domain_kind, 80),
    project_id: safeText(body.project_id, 120),
    lane_id: safeText(body.lane_id, 120),
    board_id: safeText(body.board_id, 120),
    graph_path: safeGraphPath(body.graph_path),
    component_id: safeText(body.component_id, 120),
    control_id: safeText(body.control_id, 120),
    action_id: safeText(body.action_id, 160),
    target_label: safeText(body.target_label, 180),
    source_adapter: safeText(body.source_adapter, 120) || 'xlooop_feedback_annotation_layer',
    data_provenance: safeText(body.data_provenance, 180),
    build_sha: safeText(body.build_sha, 120),
    resolution_ref: safeText(body.resolution_ref, 240),
    receipt_id: safeText(body.receipt_id, 160),
  };
  return { ok: true, row };
}

function safeText(value, max = 500) {
  return String(value || '')
    .replace(/\/Users\/[^ \n\t"')]+/g, '[local-path-redacted]')
    .replace(/MB-P\/_sys\/[^ \n\t"')]+/g, '[internal-governance-path-redacted]')
    .replace(/HR-[A-Z0-9_-]+/g, '[internal-rule-id-redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[secret-redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeGraphPath(value) {
  return String(value || 'workspace/xlooop/domain/current/project/current/lane/current/board/current')
    .split('/')
    .map((part) => safeText(part, 80).toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown')
    .join('/')
    .slice(0, 600);
}

function forbiddenContent(value) {
  const raw = String(value || '');
  if (/\/Users\/maratbasyrov\//.test(raw)) return 'local_user_path';
  if (/git-crypt-key|OPENAI_API_KEY|CLOUDFLARE_API_TOKEN/i.test(raw)) return 'secret_reference';
  if (/MB-P\/_sys\/xcp-system\/governance/i.test(raw)) return 'private_governance_path';
  return null;
}

async function getAccessIdentity(env, request) {
  const resolved = await resolveAccessIdentity(env, request);
  if (resolved.ok) {
    return {
      email: resolved.identity.email || null,
      service_token: resolved.identity.service_token || (resolved.identity.identity_source === 'cloudflare_access_service_token' ? 'service-token' : null),
    };
  }
  const headers = request.headers;
  const email = headers.get('Cf-Access-Authenticated-User-Email')
    || headers.get('CF-Access-Authenticated-User-Email')
    || headers.get('x-forwarded-email');
  const serviceToken = headers.get('CF-Access-Client-Id')
    || headers.get('Cf-Access-Client-Id')
    || headers.get('cf-access-client-id');
  return { email: email || null, service_token: serviceToken ? 'service-token' : null };
}

function hasAccessIdentity(identity) {
  return Boolean(identity?.email || identity?.service_token);
}

function accessRequired(env) {
  return String(env.FEEDBACK_REQUIRE_ACCESS || '').toLowerCase() === '1';
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
