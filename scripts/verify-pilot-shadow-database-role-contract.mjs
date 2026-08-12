#!/usr/bin/env node

import { neon } from '@neondatabase/serverless';

const OWNER_ROLE = 'neondb_owner';
const APP_ROLE = 'xlooop_app';

export function assess(owner, app) {
  const failures = [];
  if (owner.role_name !== OWNER_ROLE) failures.push(`DATABASE_URL role must be ${OWNER_ROLE}`);
  if (app.role_name !== APP_ROLE) failures.push(`XLOOOP_RLS_APP_DATABASE_URL role must be ${APP_ROLE}`);
  if (owner.role_name === app.role_name) failures.push('owner and app DSNs resolve to the same role');
  if (app.is_superuser) failures.push(`${APP_ROLE} must not be superuser`);
  if (app.bypasses_rls) failures.push(`${APP_ROLE} must not bypass RLS`);
  if (app.users_select || app.synthetic_membership_select) {
    failures.push(`${APP_ROLE} must not have direct broad-table SELECT privileges`);
  }
  if (Number(owner.schema_head) !== 101) failures.push('owner DSN must resolve to schema head 101');
  if (owner.database_name !== app.database_name) failures.push('owner and app DSNs must resolve to the same database');
  return failures;
}

if (process.argv.includes('--self-test')) {
  const good = assess(
    { role_name: OWNER_ROLE, schema_head: 101, database_name: 'neondb' },
    { role_name: APP_ROLE, database_name: 'neondb', is_superuser: false, bypasses_rls: false, users_select: false, synthetic_membership_select: false },
  );
  const swapped = assess(
    { role_name: APP_ROLE, schema_head: 101, database_name: 'neondb' },
    { role_name: OWNER_ROLE, database_name: 'other', is_superuser: false, bypasses_rls: false, users_select: true, synthetic_membership_select: true },
  );
  const ok = good.length === 0 && swapped.length >= 3;
  console.log(JSON.stringify({ schema_id: 'xlooop.pilot_shadow_database_role_contract.self_test.v1', status: ok ? 'PASS' : 'FAIL' }));
  process.exit(ok ? 0 : 1);
}

const ownerUrl = process.env.DATABASE_URL?.trim();
const appUrl = process.env.XLOOOP_RLS_APP_DATABASE_URL?.trim();
if (!ownerUrl || !appUrl) {
  console.error(JSON.stringify({
    schema_id: 'xlooop.pilot_shadow_database_role_contract.v1',
    status: 'FAIL',
    failures: ['DATABASE_URL and XLOOOP_RLS_APP_DATABASE_URL are required'],
  }, null, 2));
  process.exit(2);
}

async function inspect(url, includeSchemaHead) {
  const sql = neon(url);
  const [row] = includeSchemaHead ? await sql`
    SELECT current_user AS role_name,
           current_database() AS database_name,
           r.rolsuper AS is_superuser,
           r.rolbypassrls AS bypasses_rls,
           has_table_privilege(current_user, 'public.users', 'SELECT') AS users_select,
           has_table_privilege(current_user, 'public.synthetic_domain_membership', 'SELECT') AS synthetic_membership_select,
           (SELECT max(version)::int FROM workers_schema_version) AS schema_head
      FROM pg_roles r
     WHERE r.rolname = current_user
  ` : await sql`
    SELECT current_user AS role_name,
           current_database() AS database_name,
           r.rolsuper AS is_superuser,
           r.rolbypassrls AS bypasses_rls,
           has_table_privilege(current_user, 'public.users', 'SELECT') AS users_select,
           has_table_privilege(current_user, 'public.synthetic_domain_membership', 'SELECT') AS synthetic_membership_select
      FROM pg_roles r
     WHERE r.rolname = current_user
  `;
  return row;
}

const [owner, app] = await Promise.all([inspect(ownerUrl, true), inspect(appUrl, false)]);
const failures = assess(owner, app);
console.log(JSON.stringify({
  schema_id: 'xlooop.pilot_shadow_database_role_contract.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  owner: { role_name: owner.role_name, database_name: owner.database_name, schema_head: Number(owner.schema_head) },
  app: {
    role_name: app.role_name,
    database_name: app.database_name,
    is_superuser: Boolean(app.is_superuser),
    bypasses_rls: Boolean(app.bypasses_rls),
    broad_select_privileges: Boolean(app.users_select || app.synthetic_membership_select),
  },
  failures,
}, null, 2));
process.exit(failures.length ? 1 : 0);
