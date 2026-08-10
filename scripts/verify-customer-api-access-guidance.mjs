#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = loadSources();

const checks = [];
const check = (id, ok, detail) => checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail });

check('single_gateway_name', /XCP_GATEWAY_NAME = 'xcp-gateway'/.test(source.gateway) && /name: 'xcp-gateway'/.test(source.rpc), 'REST and MCP expose one canonical gateway name.');
check('single_intake_tool', /name: 'xcp_session_start'/.test(source.gateway) && /name: 'xcp_session_start'/.test(source.rpc), 'Customer profile starts through xcp_session_start.');
check('no_legacy_whoami_tool', !/name: 'xlooop\.whoami'/.test(source.gateway) && !/name: 'xlooop\.whoami'/.test(source.rpc), 'Legacy whoami is not an MCP tool.');
check('protected_route_mount', source.index.includes("protectedRoutes.route('/', developerAccessRoute);") && !source.index.includes("publicRoutes.route('/', developerAccessRoute);"), 'Developer access routes are authenticated.');
check('status_and_receipt_routes', /get\('\/developer-access\/status'/.test(source.route) && /post\('\/developer-access\/test'/.test(source.route) && /developer_access_test_receipt/.test(source.route), 'Settings can read readiness and produce a redacted connection receipt.');
check('supported_clients', ['Claude Code', 'Codex', 'Cursor', 'Browser test'].every((client) => source.route.includes(client)), 'Supported customer clients are explicit.');
check('safe_tools_single_source', /SAFE_TOOLS/.test(source.route) && /MCP_FORBIDDEN_SURFACES/.test(source.route), 'Allowed and forbidden surfaces derive from the gateway contract.');
check('human_only_token_mint', /auth\.auth_method !== 'clerk_jwt'/.test(source.route) && /authorizeGovernedWrite\(ctx, 'token:create'\)/.test(source.route), 'Only governed human sessions can mint connector tokens.');
check('token_feature_flags', /CUSTOMER_API_TOKENS_ENABLED/.test(source.route) && /CUSTOMER_OPERATIONAL_TOKENS_ENABLED/.test(source.route), 'Read and operational token issuance have separate default-off flags.');
check('show_once_hash_only_token', /mintRawToken/.test(source.route) && /hashToken\(raw\)/.test(source.route) && /token:\s*raw/.test(source.route), 'Raw connector credentials are returned once while storage receives only a hash.');
check('bounded_expiry', /Date\.now\(\) \+ 90 \* 86400000/.test(source.route), 'Issued connector tokens have a bounded expiry.');
check('workspace_scoped_revoke', /revokeCustomerToken\(auth\.workspace_id/.test(source.route) && /customer_token_revoke/.test(source.route), 'Revocation is workspace scoped and audited.');
check('token_safety_verifier', /membership-bound, revocable connector tokens/.test(source.tokenSafety) && /revoked_at IS NULL/.test(source.tokenSafety), 'Dedicated token verifier covers revocation and delegated membership.');
check('route_regression_matrix', ['409', '201', '403', '200'].every((status) => source.tests.includes(`toBe(${status})`)), 'Route tests cover disabled, mint, denial, list, and revoke behavior.');
check('onboarding_single_intake', source.docs.includes('first and only intake call must be `xcp_session_start`') && source.runbook.includes('call xcp_session_start once'), 'Customer onboarding names one intake call.');
check('onboarding_forbidden_surfaces', ['raw graph', 'full tenant memory', 'governance scoring', 'secrets'].every((marker) => source.docs.toLowerCase().includes(marker)), 'Customer onboarding documents forbidden internal surfaces.');
check('command_registered', source.packageJson.scripts?.['verify:customer-api-access-guidance'] === 'node scripts/verify-customer-api-access-guidance.mjs', 'Guidance verifier is registered.');

const failures = checks.filter((row) => row.status === 'FAIL');
console.log(JSON.stringify({
  schema_id: 'xlooop.customer_api_access_guidance.verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  check_count: checks.length,
  failure_count: failures.length,
  checks,
}, null, 2));
process.exit(failures.length ? 1 : 0);

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

function loadSources() {
  return {
    index: read('src/workers/index.ts'),
    route: read('src/workers/routes/developer-access.ts'),
    gateway: read('src/workers/routes/mcp-gateway.ts'),
    rpc: read('src/workers/routes/mcp-rpc.ts'),
    tokenSafety: read('scripts/verify-customer-connector-token-safety.mjs'),
    tests: read('src/workers/__tests__/developer-access-route.test.ts'),
    docs: read('docs/customer-onboarding/CLAUDE_CODE_API_ONBOARDING.md'),
    runbook: read('docs/customer-onboarding/CONNECTOR_TOKEN_AND_MCP_ACTIVATION_RUNBOOK.md'),
    packageJson: JSON.parse(read('package.json')),
  };
}
