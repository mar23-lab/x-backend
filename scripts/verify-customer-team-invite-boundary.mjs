import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();
const routePath = path.join(repoRoot, 'src/workers/routes/customer.ts');
const servicePath = path.join(repoRoot, 'src/workers/services/clerk-org.ts');
const seedPath = path.join(repoRoot, 'src/workers/db/seed/customer-template.sql');
const route = fs.readFileSync(routePath, 'utf8');
const service = fs.readFileSync(servicePath, 'utf8');
const seed = fs.readFileSync(seedPath, 'utf8');

const failures = [];

function check(condition, id, message) {
  if (!condition) failures.push({ id, message });
}

check(
  route.includes("customerRoute.post('/customer/invites'"),
  'invite_route_present',
  'customer route must expose POST /customer/invites'
);
check(
  route.includes("if (!auth?.user_id)") && route.includes("if (!auth.workspace_id)"),
  'auth_and_workspace_required',
  'invite route must require authenticated user and workspace/org scope'
);
check(
  route.includes("auth.role !== 'owner' && auth.role !== 'operator'"),
  'owner_or_operator_required',
  'invite route must only allow owner/operator callers'
);
check(
  route.includes('getCustomerAuthorityState(auth.workspace_id)') && route.includes('!authority.unlocked'),
  'authority_gate_required',
  'invite route must remain hard-gated on customer authority/consent unlock'
);
check(
  route.includes('EMAIL_RE') && route.includes('email.length > 254'),
  'email_validation_required',
  'invite route must validate invitee email before calling Clerk'
);
check(
  route.includes('createTeamInvitation(ctx.env.CLERK_SECRET_KEY') && route.includes('organizationId: auth.workspace_id'),
  'clerk_org_invite_scoped',
  'invite route must call Clerk Organizations with the current workspace/org id'
);
check(
  service.includes("from '@clerk/backend'") && service.includes('createOrganizationInvitation'),
  'clerk_backend_adapter',
  'Clerk organization API must stay isolated in the service wrapper'
);
check(
  service.includes('if (!secretKey') && service.includes('CLERK_SECRET_KEY is not configured'),
  'secret_key_guard',
  'Clerk service must fail closed when CLERK_SECRET_KEY is missing'
);
check(
  service.includes('email: invitation.emailAddress || input.emailAddress')
    && service.includes("status: invitation.status || 'pending'"),
  'normalized_result_contract',
  'Clerk service must normalize optional Clerk response fields into stable result fields'
);
check(
  !/INSERT\s+INTO\s+workspace_members/i.test(route + '\n' + service),
  'no_member_creation_before_acceptance',
  'invite flow must not create workspace_members rows before invite acceptance/sign-in'
);
check(
  !/(token|secret|rawContent|content_blob)\s*:/i.test(service),
  'no_sensitive_response_fields',
  'invite result must not return tokens, secrets, or raw content'
);
check(
  /INSERT INTO customer_authority_consents/i.test(seed)
    && /operator_approved_at/i.test(seed)
    && /authority-consent/i.test(seed),
  'seed_operator_authority_before_customer_consent',
  'customer seed must provision operator approval while keeping customer consent as an in-app unlock'
);

if (failures.length) {
  console.error('verify-customer-team-invite-boundary: FAIL');
  for (const failure of failures) console.error(`- ${failure.id}: ${failure.message}`);
  process.exit(1);
}

console.log('verify-customer-team-invite-boundary: PASS (workspace-scoped, authority-gated Clerk org invite boundary)');
