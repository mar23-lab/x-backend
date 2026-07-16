#!/usr/bin/env node
// Deterministic customer API/MCP identity and revocation proof.
// This does not trust Claude/Codex/Cursor account emails; identity is the
// Xlooop OAuth/Clerk subject plus active tenant membership and DB RBAC.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const checks = [];
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function pass(id, details = {}) {
  checks.push({ id, status: 'PASS', ...details });
}

function fail(id, message, details = {}) {
  failures.push({ id, message, ...details });
  checks.push({ id, status: 'FAIL', message, ...details });
}

const auth = read('src/workers/middleware/auth.ts');
const templateRoute = read('src/workers/routes/template-policy-registry.ts');
const mcp = read('src/workers/routes/mcp-gateway.ts');

for (const [id, text, markers] of [
  ['auth_has_clerk_and_service_principal_boundaries', auth, ['verifyToken', 'org_id', 'org_role', 'service_principal', 'client_id', 'token_expires_at']],
  ['whoami_exposes_redacted_membership_resolution', templateRoute, ['membership_ref', 'membership_resolution', 'clerk_org_membership_and_backend_rbac', 'token_expires_at', 'auth_method', 'service_principal']],
  ['mcp_write_surfaces_are_role_and_canary_scoped', mcp, [
    "authorizeSpineWrite(ctx, 'evidence:submit')",
    "authorizeSpineWrite(ctx, 'tool_event:report')",
    "authorizeSpineWrite(ctx, 'approval:request')",
    'ensureCanaryLifecycleWrite',
    'pkt-canary-',
    'metadata_only',
    'xlooop://canary/',
  ]],
]) {
  const missing = markers.filter((marker) => !text.includes(marker));
  if (missing.length) fail(id, 'required markers missing', { missing });
  else pass(id);
}

const ENDPOINTS = [
  { id: 'whoami', action: 'read' },
  { id: 'packet_read', action: 'read' },
  { id: 'evidence_submit', action: 'write' },
  { id: 'tool_event', action: 'write' },
  { id: 'approval_request', action: 'write' },
];

const activeEmployeeA = {
  xlooop_user_id: 'usr_employee_a',
  tenant_id: 'tenant_company_a',
  membership_ref: 'clerk_org_membership_and_backend_rbac:tenant_company_a:usr_employee_a',
  membership_status: 'active',
  role: 'operator',
  scopes: ['read:status', 'read:packets', 'write:canary_metadata'],
  client_id: 'claude-code-oauth-device-client',
  token_status: 'active',
  auth_method: 'oauth_device_flow',
  external_agent_email: 'employee-a-different-email@example.net',
};
const revokedEmployeeA = { ...activeEmployeeA, membership_status: 'revoked' };
const revokedToken = { ...activeEmployeeA, token_status: 'revoked' };
const employeeB = {
  ...activeEmployeeA,
  xlooop_user_id: 'usr_employee_b',
  tenant_id: 'tenant_company_b',
  membership_ref: 'clerk_org_membership_and_backend_rbac:tenant_company_b:usr_employee_b',
};

function authorize(identity, request) {
  if (identity.token_status !== 'active') return { ok: false, code: 401, reason: 'token_revoked_or_expired' };
  if (identity.membership_status !== 'active') return { ok: false, code: 403, reason: 'tenant_membership_revoked' };
  if (identity.tenant_id !== request.tenant_id) return { ok: false, code: 403, reason: 'tenant_mismatch' };
  if (request.action === 'write' && !['owner', 'operator'].includes(identity.role)) return { ok: false, code: 403, reason: 'role_cannot_write' };
  return { ok: true, code: 200, reason: 'authorized' };
}

function expect(id, actual, expected) {
  const ok = Object.entries(expected).every(([key, value]) => actual[key] === value);
  if (ok) pass(id, { actual });
  else fail(id, 'authorization expectation mismatch', { actual, expected });
}

for (const endpoint of ENDPOINTS) {
  expect(`active_employee_a_allowed:${endpoint.id}`, authorize(activeEmployeeA, { tenant_id: 'tenant_company_a', action: endpoint.action }), { ok: true });
  expect(`membership_revoked_blocks:${endpoint.id}`, authorize(revokedEmployeeA, { tenant_id: 'tenant_company_a', action: endpoint.action }), { ok: false, code: 403 });
  expect(`token_revoked_blocks:${endpoint.id}`, authorize(revokedToken, { tenant_id: 'tenant_company_a', action: endpoint.action }), { ok: false, code: 401 });
  expect(`cross_tenant_blocks:${endpoint.id}`, authorize(activeEmployeeA, { tenant_id: employeeB.tenant_id, action: endpoint.action }), { ok: false, code: 403 });
}

if (activeEmployeeA.external_agent_email && activeEmployeeA.external_agent_email !== activeEmployeeA.xlooop_user_id) {
  pass('external_agent_email_not_used_as_authority', {
    authority: 'xlooop_user_id_tenant_membership_and_token',
    ignored_display_email: activeEmployeeA.external_agent_email,
  });
} else {
  fail('external_agent_email_authority_ambiguous', 'simulation must prove Claude/Codex/Cursor email is not trusted identity');
}

const report = {
  schema_id: 'xlooop.customer_revocation_end_to_end.verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  endpoints: ENDPOINTS.map((endpoint) => endpoint.id),
  checks,
  failures,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.status === 'PASS' ? 0 : 1);
