#!/usr/bin/env node
import { onRequestGet as sessionGet } from '../functions/api/session.js';
import { onRequestPost as proposalsPost } from '../functions/api/proposals.js';
import { onRequestPost as receiptsPost } from '../functions/api/receipts.js';
import { onRequestGet as telemetryGet } from '../functions/api/telemetry/company.js';

const failures = [];
const db = createMockD1();
const baseEnv = {
  FEEDBACK_DB: db,
  FEEDBACK_REQUIRE_ACCESS: '1',
  CUSTOMER_AUTH_REQUIRE_ACCESS: '1',
  CUSTOMER_AUTH_TRUST_ACCESS_HEADERS: '1',
  XLOOOP_OWNER_EMAILS: 'xlooop23@gmail.com',
  OPERATIONS_LAST_SUCCESSFUL_POLL_AT: new Date().toISOString(),
  OPERATIONS_FRESHNESS_SLA_SECONDS: '900',
};

const unauthSession = await responseJson(await sessionGet({ env: baseEnv, request: request('/api/session') }));
check(unauthSession.status === 401, 'unauth_session_fail_closed', 'GET /api/session must fail closed without Access identity');

const newUserSession = await responseJson(await sessionGet({
  env: baseEnv,
  request: request('/api/session', { email: 'new.user@example.com' }),
}));
check(newUserSession.status === 200, 'new_user_session_ok', 'new user session must resolve with Access identity');
check(newUserSession.body.principal.tenant_id === 'tenant:customer-feedback-public', 'new_user_tenant_isolated', 'new user must not fall into MB-P tenant');
check(newUserSession.body.principal.app_entitlements.find((entry) => entry.app_id === 'xcp')?.status === 'disabled', 'new_user_xcp_disabled', 'Xlooop access must not grant XCP');
check(!newUserSession.body.customer_feedback_policy.operator_enabled, 'new_user_operator_disabled', 'customer-feedback Operator mode must be disabled by default');

const proposal = await responseJson(await proposalsPost({
  env: baseEnv,
  request: request('/api/proposals', {
    email: 'new.user@example.com',
    method: 'POST',
    body: {
      action_id: 'feedback.test.propose',
      graph_path: 'workspace/xlooop/domain/customer-feedback/project/test/lane/watch/board/actions',
      reason: 'Scenario test proposal without private data.',
    },
  }),
}));
check(proposal.status === 200 && proposal.body.persisted === true, 'new_user_proposal_persisted', 'customer-feedback user must be able to create proposal-only records');
check(db.rows.customer_feedback_proposals.length === 1, 'proposal_d1_write', 'proposal must be written to D1 table');

const receiptDenied = await responseJson(await receiptsPost({
  env: baseEnv,
  request: request('/api/receipts', {
    email: 'new.user@example.com',
    method: 'POST',
    body: { action_id: 'feedback.test.operator' },
  }),
}));
check(receiptDenied.status === 403, 'new_user_receipt_denied', 'customer-feedback user must not create Operator receipts by default');

const ownerTelemetry = await responseJson(await telemetryGet({
  env: baseEnv,
  request: request('/api/telemetry/company', { email: 'xlooop23@gmail.com' }),
}));
check(ownerTelemetry.status === 200, 'owner_company_telemetry_ok', 'Marat owner/admin must see aggregate company telemetry');
check(ownerTelemetry.body.scope === 'company_aggregate_usage', 'owner_company_telemetry_scope', 'company telemetry must be aggregate scope');
check(ownerTelemetry.body.tenant_raw_content_included === false, 'owner_company_telemetry_redacted', 'company telemetry must not include raw tenant content');

if (failures.length) {
  console.error('customer-feedback-api-scenarios: FAIL');
  for (const failure of failures) console.error(`- ${failure.id}: ${failure.message}`);
  process.exit(1);
}

console.log('customer-feedback-api-scenarios: PASS (Access fail-closed, tenant isolation, XCP default-deny, proposal persistence, receipt denial, owner aggregate telemetry)');

function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.email) headers.set('Cf-Access-Authenticated-User-Email', options.email);
  if (options.method === 'POST') headers.set('content-type', 'application/json');
  return new Request(`https://xlooop-test.pages.dev${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function responseJson(response) {
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

function createMockD1() {
  const rows = {
    customer_feedback_tenant_memberships: [],
    customer_feedback_app_entitlements: [],
    customer_feedback_proposals: [],
    customer_feedback_receipts: [],
    customer_feedback_monitoring_events: [],
    feedback_annotations: [],
  };
  return {
    rows,
    prepare(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      return {
        bind(...params) {
          return {
            async all() {
              const email = String(params[0] || '').toLowerCase();
              if (normalized.includes('from customer_feedback_tenant_memberships')) {
                return { results: rows.customer_feedback_tenant_memberships.filter((row) => row.email.toLowerCase() === email && row.status === 'active') };
              }
              if (normalized.includes('from customer_feedback_app_entitlements')) {
                return { results: rows.customer_feedback_app_entitlements.filter((row) => row.email.toLowerCase() === email) };
              }
              return { results: [] };
            },
            async first() {
              const match = normalized.match(/from ([a-z_]+)/);
              const table = match?.[1];
              return { count: rows[table]?.length || 0 };
            },
            async run() {
              if (normalized.startsWith('insert into customer_feedback_proposals')) {
                rows.customer_feedback_proposals.push({
                  proposal_id: params[0],
                  tenant_id: params[1],
                  action_id: params[7],
                });
              } else if (normalized.startsWith('insert into customer_feedback_receipts')) {
                rows.customer_feedback_receipts.push({
                  receipt_id: params[0],
                  tenant_id: params[1],
                  action_id: params[7],
                });
              } else if (normalized.startsWith('insert into customer_feedback_monitoring_events')) {
                rows.customer_feedback_monitoring_events.push({
                  event_id: params[0],
                  event_type: params[1],
                  tenant_id: params[2],
                });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function check(ok, id, message) {
  if (!ok) failures.push({ id, message });
}
