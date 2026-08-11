#!/usr/bin/env node
// Live Postgres proof for migration 101. Synthetic writes are transaction-bound and rolled back.

import { Client } from 'pg';

const OWNER_ENV = 'XLOOOP_SCHEMA101_OWNER_PG_URL';
const APP_ENV = 'XLOOOP_SCHEMA101_APP_PG_URL';

export function assessEnvironment(env) {
  const ownerUrl = String(env[OWNER_ENV] || '').trim();
  const appUrl = String(env[APP_ENV] || '').trim();
  const problems = [];
  if (!ownerUrl) problems.push(`${OWNER_ENV} is required`);
  if (!appUrl) problems.push(`${APP_ENV} is required`);
  if (ownerUrl && appUrl && ownerUrl === appUrl) problems.push('owner and restricted app URLs must differ');
  for (const [label, value] of [[OWNER_ENV, ownerUrl], [APP_ENV, appUrl]]) {
    if (!value) continue;
    try {
      if (!['postgres:', 'postgresql:'].includes(new URL(value).protocol)) problems.push(`${label} must use postgres or postgresql`);
    } catch {
      problems.push(`${label} must be a valid URL`);
    }
  }
  return problems;
}

async function sqlState(client, text, values = []) {
  try {
    await client.query(text, values);
    return 'accepted';
  } catch (error) {
    return error?.code || `unknown:${error?.message || error}`;
  }
}

async function ownerChecks(client) {
  const checks = [];
  const check = (id, ok, detail = null) => checks.push({ id, ok, detail });
  const version = await client.query('SELECT count(*)::int AS count FROM workers_schema_version WHERE version = 101');
  check('schema_version_101_recorded', version.rows[0]?.count === 1, version.rows[0]);

  const tables = await client.query(`
    SELECT relname, relrowsecurity
    FROM pg_class
    WHERE relname IN ('connector_oauth_grants', 'connector_oauth_state_nonces')
  `);
  const tableMap = new Map(tables.rows.map((row) => [row.relname, row]));
  check('credential_table_exists_with_rls', tableMap.get('connector_oauth_grants')?.relrowsecurity === true, tables.rows);
  check('nonce_table_exists_with_rls', tableMap.get('connector_oauth_state_nonces')?.relrowsecurity === true, tables.rows);

  const constraints = await client.query(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'user_source_connections'::regclass
      AND conname IN (
        'user_source_connections_user_id_provider_key',
        'user_source_connections_oauth_grant_workspace_fk'
      )
  `);
  const constraintMap = new Map(constraints.rows.map((row) => [row.conname, row.definition]));
  check('legacy_global_uniqueness_removed', !constraintMap.has('user_source_connections_user_id_provider_key'), constraints.rows);
  check(
    'tenant_user_grant_fk_exact',
    String(constraintMap.get('user_source_connections_oauth_grant_workspace_fk') || '').includes(
      'FOREIGN KEY (oauth_grant_id, workspace_id, user_id) REFERENCES connector_oauth_grants(id, workspace_id, user_id)',
    ),
    constraints.rows,
  );

  const indexes = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'user_source_connections'
      AND indexname IN (
        'user_source_connections_legacy_user_provider_key',
        'user_source_connections_tenant_user_provider_key'
      )
  `);
  const indexMap = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
  check(
    'legacy_partial_uniqueness_exact',
    /UNIQUE INDEX .* \(user_id, provider\) WHERE \(oauth_grant_id IS NULL\)/.test(
      String(indexMap.get('user_source_connections_legacy_user_provider_key') || ''),
    ),
    indexes.rows,
  );
  check(
    'tenant_partial_uniqueness_exact',
    /UNIQUE INDEX .* \(workspace_id, user_id, provider\) WHERE \(oauth_grant_id IS NOT NULL\)/.test(
      String(indexMap.get('user_source_connections_tenant_user_provider_key') || ''),
    ),
    indexes.rows,
  );

  const privileges = await client.query(`
    SELECT count(*)::int AS count
    FROM information_schema.role_table_grants
    WHERE grantee = 'xlooop_app'
      AND table_name IN ('connector_oauth_grants', 'connector_oauth_state_nonces')
  `);
  check('app_role_has_zero_credential_table_privileges', privileges.rows[0]?.count === 0, privileges.rows[0]);

  const marker = `${process.pid}_${Date.now()}`;
  const user = `schema101_user_${marker}`;
  const grantA = `schema101_grant_a_${marker}`;
  const grantB = `schema101_grant_b_${marker}`;
  const wsA = `schema101_ws_a_${marker}`;
  const wsB = `schema101_ws_b_${marker}`;
  const wsC = `schema101_ws_c_${marker}`;
  await client.query('BEGIN');
  try {
    const insertGrant = `INSERT INTO connector_oauth_grants
      (id, workspace_id, user_id, authority_provider, provider_account_id, token_ciphertext, token_iv)
      VALUES ($1, $2, $3, 'google', 'schema101_account', 'ciphertext', 'iv')`;
    await client.query(insertGrant, [grantA, wsA, user]);
    await client.query(insertGrant, [grantB, wsB, user]);
    const insertSource = `INSERT INTO user_source_connections
      (id, workspace_id, user_id, provider, oauth_grant_id)
      VALUES ($1, $2, $3, 'gmail', $4)`;
    await client.query(insertSource, [`schema101_source_a_${marker}`, wsA, user, grantA]);
    await client.query(insertSource, [`schema101_source_b_${marker}`, wsB, user, grantB]);
    check('same_user_provider_allowed_in_two_tenants', true);

    await client.query('SAVEPOINT wrong_tenant');
    const crossTenant = await sqlState(client, insertSource, [`schema101_source_cross_${marker}`, wsC, user, grantA]);
    await client.query('ROLLBACK TO SAVEPOINT wrong_tenant');
    check('cross_tenant_grant_binding_rejected', crossTenant === '23503', crossTenant);

    await client.query('SAVEPOINT duplicate_tenant');
    const duplicateTenant = await sqlState(client, insertSource, [`schema101_source_duplicate_${marker}`, wsA, user, grantA]);
    await client.query('ROLLBACK TO SAVEPOINT duplicate_tenant');
    check('duplicate_tenant_provider_rejected', duplicateTenant === '23505', duplicateTenant);
  } finally {
    await client.query('ROLLBACK');
  }
  return checks;
}

function selfTest() {
  const cases = [
    ['missing both URLs', assessEnvironment({}).length === 2],
    ['different Postgres URLs accepted', assessEnvironment({
      [OWNER_ENV]: 'postgresql://owner.example/db',
      [APP_ENV]: 'postgresql://app.example/db',
    }).length === 0],
    ['same URL rejected', assessEnvironment({
      [OWNER_ENV]: 'postgresql://same.example/db',
      [APP_ENV]: 'postgresql://same.example/db',
    }).includes('owner and restricted app URLs must differ')],
    ['non-Postgres URL rejected', assessEnvironment({
      [OWNER_ENV]: 'https://owner.example/db',
      [APP_ENV]: 'postgresql://app.example/db',
    }).some((problem) => problem.includes('must use postgres'))],
  ];
  const failures = cases.filter(([, ok]) => !ok);
  if (failures.length) {
    console.error(`FAIL schema101-postgres self-test: ${failures.map(([id]) => id).join(', ')}`);
    process.exit(1);
  }
  const passed = cases.filter(([, ok]) => ok).length;
  console.log(`PASS schema101-postgres self-test: ${passed}/${cases.length} environment controls`);
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const problems = assessEnvironment(process.env);
  if (problems.length) {
    console.error(`CANNOT_MEASURE schema101-postgres (0 assertions): ${problems.join('; ')}`);
    process.exit(2);
  }
  const owner = new Client({ connectionString: process.env[OWNER_ENV] });
  const app = new Client({ connectionString: process.env[APP_ENV] });
  await owner.connect();
  await app.connect();
  try {
    const checks = await ownerChecks(owner);
    const appReadState = await sqlState(app, 'SELECT id FROM connector_oauth_grants LIMIT 1');
    checks.push({ id: 'restricted_app_role_read_rejected', ok: appReadState === '42501', detail: appReadState });
    const failures = checks.filter((item) => !item.ok);
    for (const item of checks) console.log(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.id}${item.ok ? '' : `: ${JSON.stringify(item.detail)}`}`);
    if (failures.length) {
      console.error(`FAIL schema101-postgres: ${checks.length - failures.length}/${checks.length} live invariants held`);
      process.exit(1);
    }
    const passed = checks.filter((item) => item.ok).length;
    console.log(`PASS schema101-postgres: ${passed}/${checks.length} live invariants; synthetic writes rolled back`);
  } finally {
    await owner.end().catch(() => {});
    await app.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`FAIL schema101-postgres: ${error?.message || error}`);
  process.exit(1);
});
