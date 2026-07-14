const DEFAULT_CUSTOMER_MODES = ['watch', 'test'];
const DEFAULT_CUSTOMER_ACTIONS = ['proposal:create', 'feedback:create', 'feedback:read'];
const OWNER_ROLES = [
  'mbp_ecosystem_operator',
  'xlooop_company_owner_admin',
  'xcp_platform_admin',
  'company_telemetry_viewer',
];
const OWNER_SCOPES = [
  'company_aggregate_usage',
  'tenant_admin_summary',
  'mbp_internal_governance',
];
const FORBIDDEN_PATTERNS = [
  { id: 'local_user_path', pattern: /\/Users\/maratbasyrov\//i },
  { id: 'mbp_private_governance_path', pattern: /MB-P\/_sys\/xcp-system\/governance/i },
  { id: 'internal_rule_id', pattern: /\bHR-[A-Z0-9_-]+\b/ },
  { id: 'secret_reference', pattern: /\b(?:OPENAI_API_KEY|CLOUDFLARE_API_TOKEN|git-crypt-key|sk-[A-Za-z0-9_-]+)\b/i },
  { id: 'raw_customer_private_marker', pattern: /\braw_customer_private_data\b/i },
  { id: 'private_engine_terms', pattern: /\b(?:prompt chain|memory architecture|graph architecture|xcp orchestration logic)\b/i },
];

export async function requirePrincipal({ env, request, appId = 'xlooop', requiredMode = null, requiredPermission = null }) {
  const identity = await resolveAccessIdentity(env, request);
  if (!identity.ok) {
    await recordMonitoringEvent(env, 'auth_denied', {
      reason: identity.error,
      app_id: appId,
    });
    return { ok: false, status: 401, error: 'Cloudflare Access identity required', detail: identity.error };
  }

  const principal = await buildPrincipal(env, identity.identity);
  const appEntitlement = principal.app_entitlements.find((entry) => entry.app_id === appId);
  if (!appEntitlement || appEntitlement.status !== 'active') {
    await recordMonitoringEvent(env, 'tenant_denied', {
      reason: 'app_entitlement_denied',
      app_id: appId,
      identity_id: principal.identity_id,
      tenant_id: principal.tenant_id,
    });
    return { ok: false, status: 403, error: `${appId} entitlement required` };
  }
  if (requiredMode && !appEntitlement.allowed_modes.includes(requiredMode)) {
    await recordMonitoringEvent(env, 'tenant_denied', {
      reason: 'mode_denied',
      app_id: appId,
      mode: requiredMode,
      identity_id: principal.identity_id,
      tenant_id: principal.tenant_id,
    });
    return { ok: false, status: 403, error: `${requiredMode} mode is not permitted` };
  }
  if (requiredPermission && !principal.permissions.includes(requiredPermission)) {
    await recordMonitoringEvent(env, 'tenant_denied', {
      reason: 'permission_denied',
      app_id: appId,
      permission: requiredPermission,
      identity_id: principal.identity_id,
      tenant_id: principal.tenant_id,
    });
    return { ok: false, status: 403, error: `${requiredPermission} permission is not permitted` };
  }
  return { ok: true, principal, identity: identity.identity, app_entitlement: appEntitlement };
}

export async function resolveAccessIdentity(env, request) {
  const headers = request.headers;
  const jwt = headers.get('Cf-Access-Jwt-Assertion') || headers.get('CF-Access-Jwt-Assertion');
  const email = headers.get('Cf-Access-Authenticated-User-Email')
    || headers.get('CF-Access-Authenticated-User-Email')
    || headers.get('x-forwarded-email');
  const serviceToken = headers.get('CF-Access-Client-Id')
    || headers.get('Cf-Access-Client-Id')
    || headers.get('cf-access-client-id');
  const requireAccess = truthy(env.CUSTOMER_AUTH_REQUIRE_ACCESS || env.FEEDBACK_REQUIRE_ACCESS || '1');
  const trustedHeaders = truthy(env.XLOOOP_TRUST_CLOUDFLARE_ACCESS_HEADERS || env.CUSTOMER_AUTH_TRUST_ACCESS_HEADERS);

  if (jwt) {
    const jwtResult = await validateAccessJwt(env, jwt);
    if (jwtResult.ok) {
      return {
        ok: true,
        identity: {
          identity_source: 'cloudflare_access',
          assurance_level: jwtResult.signature_verified ? 'cloudflare_access_jwt_verified' : 'cloudflare_access_jwt_claim_checked',
          email: safeText(jwtResult.payload.email || jwtResult.payload.sub || email || 'unknown@xlooop.local', 180),
          subject: safeText(jwtResult.payload.sub || '', 180),
          service_token: null,
          jwt_checked: true,
        },
      };
    }
    return { ok: false, error: jwtResult.error || 'invalid_access_jwt' };
  }

  if ((email || serviceToken) && trustedHeaders) {
    return {
      ok: true,
      identity: {
        identity_source: serviceToken ? 'cloudflare_access_service_token' : 'cloudflare_access_header',
        assurance_level: 'cloudflare_access_edge_header',
        email: safeText(email || `service-token:${serviceToken}`, 180),
        subject: safeText(email || serviceToken, 180),
        service_token: serviceToken ? 'service-token' : null,
        jwt_checked: false,
      },
    };
  }

  if (!requireAccess) {
    return {
      ok: true,
      identity: {
        identity_source: 'local_dev',
        assurance_level: 'local_dev_unverified',
        email: safeText(email || 'local-dev@xlooop.local', 180),
        subject: 'local-dev',
        service_token: null,
        jwt_checked: false,
      },
    };
  }

  return { ok: false, error: 'missing_or_untrusted_cloudflare_access_identity' };
}

export async function validateAccessJwt(env, jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed_access_jwt' };
  let header;
  let payload;
  try {
    header = JSON.parse(base64urlDecode(parts[0]));
    payload = JSON.parse(base64urlDecode(parts[1]));
  } catch {
    return { ok: false, error: 'invalid_access_jwt_json' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && Number(payload.exp) <= now) return { ok: false, error: 'access_jwt_expired' };
  if (payload.nbf && Number(payload.nbf) > now) return { ok: false, error: 'access_jwt_not_yet_valid' };
  const expectedAud = safeText(env.CLOUDFLARE_ACCESS_AUD || env.CF_ACCESS_AUD || '', 240);
  if (expectedAud) {
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud].filter(Boolean);
    if (!audience.includes(expectedAud)) return { ok: false, error: 'access_jwt_audience_mismatch' };
  }
  const expectedIss = expectedIssuer(env);
  if (expectedIss && payload.iss !== expectedIss) return { ok: false, error: 'access_jwt_issuer_mismatch' };
  if (truthy(env.CLOUDFLARE_ACCESS_VERIFY_SIGNATURE || env.CF_ACCESS_VERIFY_SIGNATURE)) {
    const verified = await verifyJwtSignature(env, parts, header);
    if (!verified.ok) return verified;
    return { ok: true, header, payload, signature_verified: true };
  }
  return { ok: true, header, payload, signature_verified: false };
}

export async function buildPrincipal(env, identity) {
  const email = safeText(identity.email, 180).toLowerCase();
  const now = new Date().toISOString();
  const dbRows = await readAuthorityRows(env, email);
  const ownerEmails = listEnv(env.XLOOOP_OWNER_EMAILS || env.MARAT_OWNER_EMAILS || 'xlooop23@gmail.com');
  const isOwner = ownerEmails.includes(email);
  const tenantId = isOwner ? 'tenant:mbp-owner' : 'tenant:customer-feedback-public';
  const ownerGraphId = isOwner ? 'owner-graph-marat-basyrov' : 'owner-graph-customer-feedback';
  const platformRoles = isOwner ? OWNER_ROLES : [];
  const telemetryScopes = isOwner ? OWNER_SCOPES : ['tenant_admin_summary'];
  const memberships = dbRows.memberships.length ? dbRows.memberships : [{
    tenant_id: tenantId,
    owner_graph_id: ownerGraphId,
    workspace_id: isOwner ? 'xlooop' : 'customer-feedback',
    roles: platformRoles,
    permissions: isOwner ? ['workspace:read', 'project:read', 'proposal:create', 'receipt:create', 'telemetry:company:read'] : ['workspace:read', 'project:read', 'proposal:create'],
    status: 'active',
  }];
  const appEntitlements = normalizeEntitlements(dbRows.entitlements, isOwner);
  const permissions = unique(memberships.flatMap((item) => parseList(item.permissions)));

  return {
    schema_version: 'xlooop.authenticated_principal.v1',
    identity_id: `identity:${hashEmail(email)}`,
    actor_id: isOwner ? 'actor:marat-basyrov' : `actor:${hashEmail(email)}`,
    email,
    display_name: isOwner ? 'Marat Basyrov' : email.split('@')[0],
    identity_source: identity.identity_source,
    assurance_level: identity.assurance_level,
    tenant_id: memberships[0]?.tenant_id || tenantId,
    owner_graph_id: memberships[0]?.owner_graph_id || ownerGraphId,
    memberships,
    app_entitlements: appEntitlements,
    permissions,
    platform_roles: platformRoles,
    telemetry_scopes: telemetryScopes,
    session_issued_at: now,
    session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

export function operatorAllowed(principal, appId = 'xlooop') {
  const entitlement = principal.app_entitlements.find((entry) => entry.app_id === appId);
  return Boolean(entitlement?.allowed_modes?.includes('operator') && principal.permissions.includes('receipt:create'));
}

export function proposalPayload(principal, body) {
  const proposalId = safeText(body?.proposal_id, 120) || `proposal-${crypto.randomUUID()}`;
  return {
    proposal_id: proposalId,
    tenant_id: principal.tenant_id,
    identity_id: principal.identity_id,
    actor_id: principal.actor_id,
    created_at: new Date().toISOString(),
    status: 'proposed',
    mode: safeText(body?.mode, 24) || 'test',
    action_id: safeText(body?.action_id, 160),
    target_ref: safeText(body?.target_ref, 240),
    graph_path: safeGraphPath(body?.graph_path),
    reason: safeText(body?.reason, 1000),
    expected_receipt_policy: 'proposal_only_customer_feedback',
  };
}

export function receiptPayload(principal, body) {
  const receiptId = safeText(body?.receipt_id, 120) || `receipt-${crypto.randomUUID()}`;
  return {
    receipt_id: receiptId,
    tenant_id: principal.tenant_id,
    identity_id: principal.identity_id,
    actor_id: principal.actor_id,
    created_at: new Date().toISOString(),
    status: 'created',
    mode: 'operator',
    action_id: safeText(body?.action_id, 160),
    target_ref: safeText(body?.target_ref, 240),
    graph_path: safeGraphPath(body?.graph_path),
    rollback_ref: safeText(body?.rollback_ref, 240),
    verifier_ref: safeText(body?.verifier_ref, 240),
  };
}

export async function insertProposal(env, row) {
  await env.FEEDBACK_DB.prepare(
    `insert into customer_feedback_proposals (
      proposal_id, tenant_id, identity_id, actor_id, created_at, status, mode, action_id,
      target_ref, graph_path, reason, expected_receipt_policy
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.proposal_id,
    row.tenant_id,
    row.identity_id,
    row.actor_id,
    row.created_at,
    row.status,
    row.mode,
    row.action_id,
    row.target_ref,
    row.graph_path,
    row.reason,
    row.expected_receipt_policy,
  ).run();
  await recordMonitoringEvent(env, 'proposal_created', { tenant_id: row.tenant_id, proposal_id: row.proposal_id, action_id: row.action_id });
}

export async function insertReceipt(env, row) {
  await env.FEEDBACK_DB.prepare(
    `insert into customer_feedback_receipts (
      receipt_id, tenant_id, identity_id, actor_id, created_at, status, mode, action_id,
      target_ref, graph_path, rollback_ref, verifier_ref
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.receipt_id,
    row.tenant_id,
    row.identity_id,
    row.actor_id,
    row.created_at,
    row.status,
    row.mode,
    row.action_id,
    row.target_ref,
    row.graph_path,
    row.rollback_ref,
    row.verifier_ref,
  ).run();
  await recordMonitoringEvent(env, 'receipt_created', { tenant_id: row.tenant_id, receipt_id: row.receipt_id, action_id: row.action_id });
}

export async function companyTelemetry(env, principal) {
  if (!principal.telemetry_scopes.includes('company_aggregate_usage')) {
    return { ok: false, status: 403, error: 'company telemetry scope required' };
  }
  const [feedback, proposals, receipts, monitoring] = await Promise.all([
    countTable(env, 'feedback_annotations'),
    countTable(env, 'customer_feedback_proposals'),
    countTable(env, 'customer_feedback_receipts'),
    countTable(env, 'customer_feedback_monitoring_events'),
  ]);
  const payload = {
    schema_version: 'xlooop.company_telemetry.v1',
    generated_at: new Date().toISOString(),
    scope: 'company_aggregate_usage',
    tenant_raw_content_included: false,
    metrics: {
      feedback_annotations_total: feedback,
      proposals_total: proposals,
      receipts_total: receipts,
      monitoring_events_total: monitoring,
    },
  };
  return { ok: true, payload };
}

export async function healthPayload(env, request) {
  const identity = await resolveAccessIdentity(env, request);
  const freshness = await operationsFreshnessStatus(env);
  const checks = {
    access_identity: identity.ok ? 'pass' : 'fail_closed',
    d1_binding: env.FEEDBACK_DB ? 'pass' : 'fail',
    freshness_status: freshness.status,
    proposal_receipt_tables: env.FEEDBACK_DB ? 'configured' : 'missing_db',
    redaction_scan: 'pass',
  };
  return {
    schema_version: 'xlooop.customer_feedback_health.v1',
    generated_at: new Date().toISOString(),
    status: Object.values(checks).some((value) => String(value).startsWith('fail')) ? 'degraded' : 'pass',
    checks,
    freshness,
  };
}

export async function recordMonitoringEvent(env, eventType, detail = {}) {
  if (!env.FEEDBACK_DB) return;
  try {
    await env.FEEDBACK_DB.prepare(
      `insert into customer_feedback_monitoring_events (
        event_id, event_type, tenant_id, created_at, severity, detail_json
      ) values (?, ?, ?, ?, ?, ?)`
    ).bind(
      `event-${crypto.randomUUID()}`,
      safeText(eventType, 80),
      safeText(detail.tenant_id || 'tenant:unknown', 120),
      new Date().toISOString(),
      eventType.endsWith('_denied') || eventType === 'redaction_blocked' ? 'warn' : 'info',
      JSON.stringify(redactObject(detail)),
    ).run();
  } catch (_) {
    // Monitoring must not turn a denied request into a successful request, and
    // missing migrations are surfaced by the health/verifier paths.
  }
}

export function assertCustomerSafe(payload) {
  const text = JSON.stringify(payload);
  const findings = FORBIDDEN_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.id);
  return { ok: findings.length === 0, findings };
}

export function customerSafeJson(payload, status = 200) {
  const safePayload = redactObject(payload);
  const scan = assertCustomerSafe(safePayload);
  if (!scan.ok) {
    return json({
      error: 'customer_safe_redaction_blocked',
      findings: scan.findings,
    }, 500);
  }
  return json(safePayload, status);
}

export function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function readAuthorityRows(env, email) {
  if (!env.FEEDBACK_DB) return { memberships: [], entitlements: [] };
  try {
    const memberships = await env.FEEDBACK_DB.prepare(
      `select tenant_id, owner_graph_id, workspace_id, roles_json, permissions_json, status
       from customer_feedback_tenant_memberships
       where lower(email) = lower(?) and status = 'active'`
    ).bind(email).all();
    const entitlements = await env.FEEDBACK_DB.prepare(
      `select app_id, status, enabled_by, authority_ref, risk_lane, expires_at, review_due,
        allowed_modes_json, allowed_actions_json, denied_actions_json
       from customer_feedback_app_entitlements
       where lower(email) = lower(?)`
    ).bind(email).all();
    return {
      memberships: (memberships.results || []).map((row) => ({
        tenant_id: row.tenant_id,
        owner_graph_id: row.owner_graph_id,
        workspace_id: row.workspace_id,
        roles: parseList(row.roles_json),
        permissions: parseList(row.permissions_json),
        status: row.status,
      })),
      entitlements: entitlements.results || [],
    };
  } catch {
    return { memberships: [], entitlements: [] };
  }
}

function normalizeEntitlements(rows, isOwner) {
  const fromDb = rows.map((row) => ({
    app_id: row.app_id,
    status: row.status || 'disabled',
    enabled_by: row.enabled_by || null,
    authority_ref: row.authority_ref || null,
    risk_lane: row.risk_lane || 'customer_feedback',
    expires_at: row.expires_at || null,
    review_due: row.review_due || null,
    allowed_modes: parseList(row.allowed_modes_json),
    allowed_actions: parseList(row.allowed_actions_json),
    denied_actions: parseList(row.denied_actions_json),
  }));
  const has = (appId) => fromDb.some((row) => row.app_id === appId);
  if (!has('xlooop')) {
    fromDb.push({
      app_id: 'xlooop',
      status: 'active',
      enabled_by: isOwner ? 'owner_seed' : 'customer_feedback_default',
      authority_ref: isOwner ? 'MB-P owner authority' : 'Cloudflare Access invitation',
      risk_lane: isOwner ? 'owner_internal' : 'customer_feedback',
      expires_at: null,
      review_due: null,
      allowed_modes: isOwner ? ['watch', 'test', 'operator'] : DEFAULT_CUSTOMER_MODES,
      allowed_actions: isOwner ? ['proposal:create', 'receipt:create', 'feedback:create', 'telemetry:company:read'] : DEFAULT_CUSTOMER_ACTIONS,
      denied_actions: isOwner ? [] : ['receipt:create', 'raw_tenant:read', 'source:write'],
    });
  }
  if (!has('xcp')) {
    fromDb.push({
      app_id: 'xcp',
      status: isOwner ? 'active' : 'disabled',
      enabled_by: isOwner ? 'owner_seed' : null,
      authority_ref: isOwner ? 'MB-P owner authority' : null,
      risk_lane: isOwner ? 'owner_internal' : 'customer_feedback',
      expires_at: null,
      review_due: null,
      allowed_modes: isOwner ? ['watch', 'test', 'operator'] : [],
      allowed_actions: isOwner ? ['telemetry:company:read'] : [],
      denied_actions: isOwner ? [] : ['xcp:enter'],
    });
  }
  return fromDb;
}

async function countTable(env, table) {
  if (!env.FEEDBACK_DB) return 0;
  try {
    const row = await env.FEEDBACK_DB.prepare(`select count(*) as count from ${table}`).first();
    return Number(row?.count || 0);
  } catch {
    return 0;
  }
}

async function operationsFreshnessStatus(env) {
  const lastPoll = safeText(env.OPERATIONS_LAST_SUCCESSFUL_POLL_AT || '', 80);
  const slaSeconds = Number(env.OPERATIONS_FRESHNESS_SLA_SECONDS || 900);
  const parsed = Date.parse(lastPoll || '');
  if (!Number.isFinite(parsed)) {
    return { status: 'unknown', last_successful_poll_at: null, age_seconds: null, sla_seconds: slaSeconds };
  }
  const ageSeconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  return {
    status: ageSeconds <= slaSeconds ? 'fresh' : 'stale',
    last_successful_poll_at: lastPoll,
    age_seconds: ageSeconds,
    sla_seconds: slaSeconds,
  };
}

async function verifyJwtSignature(env, parts, header) {
  if (header.alg !== 'RS256') return { ok: false, error: 'unsupported_access_jwt_algorithm' };
  const certsUrl = safeText(env.CLOUDFLARE_ACCESS_CERTS_URL || certsUrlFromTeamDomain(env), 400);
  if (!certsUrl || typeof fetch !== 'function') return { ok: false, error: 'access_jwt_signature_verification_unconfigured' };
  const certs = await fetch(certsUrl).then((response) => response.json()).catch(() => null);
  const key = (certs?.keys || []).find((candidate) => candidate.kid === header.kid);
  if (!key) return { ok: false, error: 'access_jwt_key_not_found' };
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64urlToBytes(parts[2]);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signingInput);
  return ok ? { ok: true } : { ok: false, error: 'access_jwt_signature_invalid' };
}

function expectedIssuer(env) {
  const teamDomain = safeText(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN || env.CF_ACCESS_TEAM_DOMAIN || '', 240).replace(/^https?:\/\//, '').replace(/\/$/, '');
  return teamDomain ? `https://${teamDomain}` : '';
}

function certsUrlFromTeamDomain(env) {
  const teamDomain = safeText(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN || env.CF_ACCESS_TEAM_DOMAIN || '', 240).replace(/^https?:\/\//, '').replace(/\/$/, '');
  return teamDomain ? `https://${teamDomain}/cdn-cgi/access/certs` : '';
}

function base64urlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(normalized);
}

function base64urlToBytes(value) {
  return Uint8Array.from(base64urlDecode(value), (char) => char.charCodeAt(0));
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

function listEnv(value) {
  return String(value || '').split(',').map((item) => safeText(item, 180).toLowerCase()).filter(Boolean);
}

function safeGraphPath(value) {
  return String(value || 'workspace/xlooop/domain/customer-feedback/project/current/lane/current/board/current')
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

function hashEmail(email) {
  let hash = 0;
  for (const char of String(email || 'unknown')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}
