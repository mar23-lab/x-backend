#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv.find((arg) => arg.startsWith('--check='))?.split('=')[1] || 'all';
const allowed = new Set(['all', 'annotations', 'hardening']);
if (!allowed.has(requested)) {
  console.error(`feedback-runtime-contract: FAIL · unknown check ${requested}`);
  process.exit(2);
}

const source = loadSources();

const checks = [];
const check = (id, ok, detail) => checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail });

check('protected_route_import', source.index.includes("import { feedbackRoute } from './routes/feedback';"), 'Worker imports the feedback route.');
check('protected_route_mount', source.index.includes("protectedRoutes.route('/', feedbackRoute);"), 'Feedback is mounted under authenticated operational routes.');
check('not_publicly_mounted', !source.index.includes("publicRoutes.route('/', feedbackRoute);"), 'Feedback is not mounted under public routes.');
check('default_off_feature_flag', /!envFlagTrue\(ctx\.env\.FEEDBACK_PERSISTENCE_ENABLED\)[\s\S]*409/.test(source.route), 'Persistence fails closed unless explicitly enabled.');
check('tenant_from_authenticated_workspace', /gateCustomerWorkspace\(ctx as never\)/.test(source.route) && /workspace_id:\s*gate\.ws/.test(source.route), 'Workspace identity comes from the authenticated gate.');
check('body_validation', /!text \|\| text\.length > 2000/.test(source.route), 'Feedback body is required and capped at 2,000 characters.');
check('daily_rate_cap', /DAY_CAP = 50/.test(source.route) && /countFeedbackTodayRow/.test(source.route) && /429/.test(source.route), 'Per-user daily cap is enforced.');
check('metadata_caps', /target_label[\s\S]*slice\(0, 200\)/.test(source.route) && /page[\s\S]*slice\(0, 200\)/.test(source.route), 'Target and page metadata are bounded.');
check('audited_submission', /action:\s*'feedback_submitted'/.test(source.route) && /workspace_id:\s*gate\.ws/.test(source.route), 'Submission emits a workspace-scoped audit event.');
check('observable_submission', /emitEvent\('feedback_submitted'/.test(source.route), 'Submission emits structured observability.');
check('live_response_class', /withDataClass\([\s\S]*'live'\)/.test(source.route), 'Successful writes are labelled as live data.');
check('store_write_tenant_scope', /INSERT INTO feedback[\s\S]*workspace_id[\s\S]*input\.workspace_id/.test(source.store), 'Persistence includes workspace scope.');
check('store_reads_tenant_scope', /WHERE workspace_id = \$\{workspaceId\}/.test(source.store), 'Read/count queries require workspace scope.');
check('database_rls', /ALTER TABLE feedback ENABLE ROW LEVEL SECURITY/.test(source.migration) && /WITH CHECK \(workspace_id = xlooop_rls_workspace_id\(\)\)/.test(source.migration), 'Database RLS enforces workspace scope.');
check('database_constraints', /char_length\(body\) <= 2000/.test(source.migration) && /feedback_ws_user_day_idx/.test(source.migration), 'Database constraints support payload and rate controls.');
check('route_regression_matrix', ['409', '201', '403', '400', '429'].every((status) => source.tests.includes(`toBe(${status})`)), 'Tests cover disabled, success, tenant, validation, and rate-limit states.');

if (requested !== 'annotations') {
  check('owner_only_triage', /authorizeGovernedWrite\(ctx as never, 'token:read'\)/.test(source.route) && /requires the workspace owner or an operator/.test(source.route), 'Triage reads require governed owner/operator authority.');
  check('list_limit_bounded', /Math\.min\(500/.test(source.route) && /Math\.min\(500/.test(source.store), 'List limits are bounded in route and store.');
  check('read_test_matrix', /viewer.*403; owner.*200 workspace-scoped list/.test(source.tests), 'Tests prove viewer denial and owner workspace-scoped read.');
  const responsePayloads = [...source.route.matchAll(/ctx\.json\(([\s\S]*?)\);/g)]
    .map((match) => match[1])
    .join('\n');
  check('no_raw_secret_surface', !/(DATABASE_URL|CLERK_SECRET_KEY|token_sha256)/.test(responsePayloads), 'Customer feedback response construction does not expose credential material.');
}

check('annotations_command_registered', source.packageJson.scripts?.['verify:feedback-annotations'] === 'node scripts/verify-feedback-runtime-contract.mjs --check=annotations', 'Annotations lane is registered.');
check('hardening_command_registered', source.packageJson.scripts?.['verify:customer-feedback-tools-hardening'] === 'node scripts/verify-feedback-runtime-contract.mjs --check=hardening', 'Hardening lane is registered.');

const failures = checks.filter((row) => row.status === 'FAIL');
const report = {
  schema_id: 'xlooop.feedback_runtime_contract.verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  lane: requested,
  check_count: checks.length,
  failure_count: failures.length,
  checks,
};
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

function loadSources() {
  return {
    index: read('src/workers/index.ts'),
    route: read('src/workers/routes/feedback.ts'),
    store: read('src/workers/dal/feedback-store.ts'),
    migration: read('src/workers/db/migrations/061_feedback.sql'),
    tests: read('src/workers/__tests__/feedback-route.test.ts'),
    packageJson: JSON.parse(read('package.json')),
  };
}
