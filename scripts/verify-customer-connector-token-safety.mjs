#!/usr/bin/env node
// Static security-invariant verifier for the customer connector-token feature (migrations 037 + 100).
// Matches the existing verify-customer-*.mjs pattern: read source, assert invariants, exit 1 on
// any failure. Protects the auth/isolation guarantees of the read-only/operational connector token
// against regression.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const failures = [];

const files = {
  migration: 'src/workers/db/migrations/037_customer_api_tokens.sql',
  authorityMigration: 'src/workers/db/migrations/100_customer_token_delegation_authority.sql',
  store: 'src/workers/dal/customer-token-store.ts',
  auth: 'src/workers/middleware/auth.ts',
  route: 'src/workers/routes/developer-access.ts',
  oauth: 'src/workers/routes/oauth-as.ts',
  scopes: 'src/workers/lib/customer-connector-scopes.ts',
  gateway: 'src/workers/routes/mcp-gateway.ts',
  workerIndex: 'src/workers/index.ts',
  packageJson: 'package.json',
};
const src = Object.fromEntries(Object.entries(files).map(([k, rel]) => [k, read(rel)]));
const pkg = JSON.parse(src.packageJson);
const mintRoute = src.route.match(/developerAccessRoute\.post\('\/developer-access\/tokens',[\s\S]*?\n}\);/)?.[0] || '';

// ---- Migration: hash-only storage, mandatory expiry, revocation, explicit role ----
check(src.migration.includes('token_sha256') && /token_sha256\s+TEXT[^\n]*UNIQUE/.test(src.migration),
  'mig_hash_only', 'Migration must store the token as a UNIQUE token_sha256, never raw.');
check(/token_sha256[^\n]*~ '\^\[a-f0-9\]\{64\}\$'/.test(src.migration),
  'mig_hash_format', 'Migration must constrain token_sha256 to 64 lower-case hex.');
check(src.migration.includes('expires_at') && src.migration.includes('NOT NULL'),
  'mig_mandatory_expiry', 'Migration must require a non-null expires_at (no infinite tokens).');
check(src.migration.includes('revoked_at'),
  'mig_revocation_column', 'Migration must have revoked_at for instant revocation.');
check(/role[^\n]*CHECK[^\n]*'viewer'[^\n]*'operator'/.test(src.migration),
  'mig_role_explicit', 'Migration must CHECK-bind role to viewer/operator only.');
check(!/\n\s*token\s+TEXT/.test(src.migration),
  'mig_no_raw_token_column', 'Migration must not have a raw token column (only token_sha256).');

// ---- Migration 100: explicit capabilities + delegated membership authority ----
const scopeDefault = src.authorityMigration.match(/ADD COLUMN IF NOT EXISTS scopes TEXT\[\][\s\S]*?\]::TEXT\[\]/)?.[0] || '';
check(scopeDefault.includes('NOT NULL DEFAULT ARRAY') && scopeDefault.includes("'read:session'") && !scopeDefault.includes("'write:"),
  'mig100_read_only_scope_default', 'Migration 100 must default existing tokens to explicit read-only scopes.');
check(/authority_mode TEXT NOT NULL DEFAULT 'tenant_service'/.test(src.authorityMigration),
  'mig100_authority_mode', 'Migration 100 must distinguish tenant-service from delegated-user authority.');
check(/issuer_membership_activated_at TIMESTAMPTZ/.test(src.authorityMigration),
  'mig100_membership_epoch', 'Migration 100 must persist the membership activated_at authority epoch.');
check(/authority_mode <> 'delegated_user' OR issuer_membership_activated_at IS NOT NULL/.test(src.authorityMigration),
  'mig100_delegated_membership_constraint', 'Delegated credentials must require a membership activation timestamp.');
check(/VALUES \(100,[\s\S]*Customer connector scopes and delegated-membership authority binding/.test(src.authorityMigration),
  'mig100_schema_version', 'Migration 100 must register its immutable schema version.');

// ---- Store: fail-closed lookups, hash never returned, workspace-scoped revoke ----
check(src.store.includes('export async function hashToken'),
  'store_hash_helper', 'Store must expose a SHA-256 hashToken helper.');
check(/getCustomerTokenByHashRow[\s\S]*revoked_at IS NULL/.test(src.store),
  'store_lookup_fail_closed', 'Hash lookup must exclude revoked tokens (revoked → access fails).');
check(/revokeCustomerTokenRow[\s\S]*workspace_id = \$\{workspaceId\}/.test(src.store),
  'store_revoke_scoped', 'Revoke must be workspace-scoped (cannot revoke another tenant token).');
check(!/RETURNING[\s\S]{0,200}token_sha256/.test(src.store) && !/SELECT[\s\S]{0,200}token_sha256[\s\S]{0,200}FROM customer_api_tokens/.test(src.store),
  'store_hash_never_returned', 'Store must never SELECT/RETURN token_sha256 (hash stays internal).');
check(/token\.scopes[\s\S]*token\.authority_mode[\s\S]*token\.issuer_membership_activated_at/.test(src.store),
  'store_loads_explicit_authority', 'Token lookup must load explicit scopes and delegated-authority metadata.');
check(/FROM workspace_members member[\s\S]*member\.status = 'active'[\s\S]*member\.removed_at IS NULL[\s\S]*member\.activated_at = token\.issuer_membership_activated_at/.test(src.store),
  'store_revalidates_delegated_membership', 'Delegated-token lookup must revalidate active membership and the exact activated_at epoch.');

// ---- Auth: inert by default, scoped, fail-closed ----
check(/customerTokenAuth[\s\S]*if \(!opts\.allowCustomerToken\) return 'miss'/.test(src.auth),
  'auth_route_opt_in', 'customerTokenAuth must be gated by opts.allowCustomerToken.');
check(/customerTokenAuth[\s\S]*!envFlagTrue\(ctx\.env\.CUSTOMER_API_TOKENS_ENABLED\)[\s\S]*return 'miss'/.test(src.auth),
  'auth_flag_inert', 'customerTokenAuth must be inert unless CUSTOMER_API_TOKENS_ENABLED=true.');
check(src.auth.includes("service_principal: 'customer_token'"),
  'auth_marks_principal', 'customerTokenAuth must mark the auth context as customer_token.');
check(/requiredCustomerScope\(ctx\.req\.method,[\s\S]*row\.scopes\.includes\(requiredScope\)[\s\S]*scope_denied/.test(src.auth),
  'auth_enforces_action_scope', 'Customer-token auth must map every request to a required action scope and deny absent scopes.');
check(/!row\.issuer_membership_active[\s\S]*authority_revoked/.test(src.auth),
  'auth_enforces_delegated_membership', 'Customer-token auth must deny when delegated membership authority is no longer active.');

// ---- Issuer: human owner/operator only, flag-gated, one-time reveal ----
check(/auth\.auth_method !== 'clerk_jwt'[\s\S]*403/.test(mintRoute),
  'mint_human_only', 'Token mint must reject non-human (service-principal) sessions.');
check(/authorizeGovernedWrite\(ctx, 'token:create'\)[\s\S]*403/.test(mintRoute),
  'mint_role_gated', 'Token mint must use the governed owner/operator authorization path.');
check(/!envFlagTrue\(ctx\.env\.CUSTOMER_API_TOKENS_ENABLED\)[\s\S]*409/.test(mintRoute),
  'mint_feature_gated', 'Token mint must be disabled unless CUSTOMER_API_TOKENS_ENABLED=true.');
check(/role === 'operator' && !envFlagTrue\(ctx\.env\.CUSTOMER_OPERATIONAL_TOKENS_ENABLED\)[\s\S]*409/.test(mintRoute),
  'mint_operator_double_gated', 'Operator (write) tokens must require CUSTOMER_OPERATIONAL_TOKENS_ENABLED.');
check(/scopes:\s*role === 'operator'[\s\S]*CUSTOMER_CONNECTOR_OPERATOR_SCOPES[\s\S]*CUSTOMER_CONNECTOR_READ_SCOPES/.test(mintRoute),
  'mint_assigns_explicit_scopes', 'Manual token minting must persist explicit read/operator scope sets.');
check(/authority_mode:\s*'tenant_service'/.test(mintRoute),
  'mint_declares_tenant_service_authority', 'Manual owner/operator credentials must explicitly declare tenant-service authority.');
check(src.route.includes('shown once') || src.route.includes('shown once and never again'),
  'mint_one_time_reveal', 'Mint response must warn the raw token is shown once.');
check(/delete\('\/developer-access\/tokens\/:id'[\s\S]*revokeCustomerToken\(auth\.workspace_id/.test(src.route),
  'revoke_endpoint_scoped', 'Revoke endpoint must be workspace-scoped.');
// Do not regress the existing read-only honesty contract.
check(src.route.includes("customer_token_fallback_status: 'not_enabled_until_revocation_proof'"),
  'route_keeps_fallback_honesty', 'Status projection must keep the token-fallback honesty string.');

// ---- Gateway write sandbox ----
check(/ensureCustomerWriteScope[\s\S]*service_principal !== 'customer_token'/.test(src.gateway),
  'gateway_write_sandbox', 'Gateway must scope customer_token writes to the token workspace.');
check((src.gateway.match(/ensureCustomerWriteScope\(ctx, auth, body\.packet_id(?:,[^)]*)?\)/g) || []).length >= 3,
  'gateway_write_sandbox_wired', 'Write sandbox must be wired into evidence, tool-event, and approval writes.');

// ---- Explicit scope catalog + delegated OAuth issuance ----
for (const [method, pathName, scope] of [
  ['POST', '/api/v1/evidence', 'write:evidence'],
  ['POST', '/api/v1/tool-events', 'write:tool_events'],
  ['POST', '/api/v1/approvals', 'write:approval_requests'],
]) {
  check(src.scopes.includes(`path === '${pathName}'`) && src.scopes.includes(`return '${scope}'`),
    `scope_map_${scope.replace(/[:_]/g, '_')}`, `${method} ${pathName} must map to ${scope}.`);
}
check(/unsupported scope:[\s\S]*write scopes are not enabled/.test(src.scopes),
  'scope_requests_fail_closed', 'Unknown scopes and disabled write scopes must fail closed.');
check(/scopes:\s*resolved\.scopes[\s\S]*scopes:\s*grant\.scopes[\s\S]*authority_mode:\s*'delegated_user'[\s\S]*issuer_membership_activated_at/.test(src.oauth),
  'oauth_preserves_delegated_scopes', 'OAuth must carry resolved scopes into a delegated token bound to membership activated_at.');
check(/FROM workspace_members[\s\S]*status = 'active'[\s\S]*removed_at IS NULL[\s\S]*access_denied/.test(src.oauth),
  'oauth_redemption_requires_active_membership', 'OAuth redemption must deny when the authorizing membership is absent or inactive.');

// ---- Index: customer tokens reach ONLY the MCP surface ----
check(src.workerIndex.includes("clerkAuth({ allowCanary: true, allowCustomerToken: true })"),
  'index_customer_token_operational_only', 'Customer tokens must be enabled only on the operational MCP routes.');
check(src.workerIndex.includes("protectedRoutes.use('*', clerkAuth());"),
  'index_protected_no_customer_token', 'Protected routes must NOT enable customer tokens (no admin/product reach).');

// ---- Self-registration ----
check(pkg.scripts?.['verify:customer-connector-token-safety'] === 'node scripts/verify-customer-connector-token-safety.mjs',
  'package_script', 'package must expose the connector-token safety verifier.');

if (failures.length) {
  console.error('customer-connector-token-safety: FAIL');
  for (const failure of failures) console.error(`  FAIL ${failure.id}: ${failure.message}`);
  process.exit(1);
}
console.log('customer-connector-token-safety: PASS (hash-only, action-scoped, membership-bound, revocable connector tokens)');

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}
function check(ok, id, message) {
  if (!ok) failures.push({ id, message });
}
