#!/usr/bin/env node
// Static blocking gate for identity/connector OAuth separation.

import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const migration = read('src/workers/db/migrations/101_connector_oauth_grants.sql');
const routes = read('src/workers/routes/sources.ts');
const cryptoSource = read('src/workers/lib/connector-oauth-crypto.ts');
const provider = read('src/workers/services/connector-oauth-provider.ts');
const store = read('src/workers/dal/connector-oauth-store.ts');
const readiness = read('src/workers/routes/settings-readiness.ts');
const registry = read('src/workers/lib/connector-registry.ts');
const apiContract = read('docs/contracts/api-contract.v1.json');
const pilotConfig = read('wrangler.pilot-shadow.toml');
const selfTest = process.argv.includes('--self-test');

function evaluate(overrides = {}) {
  const source = {
    migration, routes, cryptoSource, provider, store, readiness, registry, apiContract, pilotConfig,
    ...overrides,
  };
  const dedicatedRouteBlock = source.routes.split("sourcesRoute.post('/sources/oauth/:provider/start'")[1]
    ?.split('// POST /api/v1/sources/connect/:provider (legacy identity-backed path)')[0] ?? '';
  return [
  ['grant and nonce tables exist', /CREATE TABLE connector_oauth_grants/.test(source.migration) && /CREATE TABLE connector_oauth_state_nonces/.test(source.migration)],
  ['source grant FK binds tenant and user', /FOREIGN KEY \(oauth_grant_id, workspace_id, user_id\)/.test(source.migration)],
  ['dedicated source uniqueness is tenant scoped', source.migration.includes('user_source_connections_tenant_user_provider_key') && source.store.includes('ON CONFLICT (workspace_id, user_id, provider)')],
  ['customer app role cannot read credential tables', (source.migration.match(/REVOKE ALL ON connector_oauth_[a-z_]+ FROM xlooop_app/g) || []).length === 2],
  ['token envelope is purpose and tenant bound', source.cryptoSource.includes('xlooop:connector-oauth:v1:') && source.cryptoSource.includes('additionalData: aad')],
  ['callback state is encrypted and replay claimed', source.cryptoSource.includes('xlooop:connector-oauth:state:v1') && source.routes.includes('claimConnectorOAuthStateNonce')],
  ['Google flow uses PKCE and offline incremental consent', source.provider.includes("code_challenge_method', 'S256") && source.provider.includes("access_type', 'offline") && source.provider.includes("include_granted_scopes', 'true")],
  ['revocation is verified by failed refresh', source.provider.includes('CONNECTOR_OAUTH_REVOCATION_VERIFICATION_FAILED') && source.provider.includes('invalid_grant')],
  ['dedicated routes do not invoke Clerk authority', dedicatedRouteBlock.length > 100 && !/makeClerkOAuthAdapter|createExternalAccount|CLERK_SECRET_KEY/.test(dedicatedRouteBlock)],
  ['legacy Google materialization is blocked when dedicated mode is active', source.routes.includes('USE_DEDICATED_CONNECTOR_OAUTH')],
  ['shared grant is retained until final source', source.store.includes("upstream_status === 'retained_shared'") && source.store.includes('(SELECT count FROM active_refs) > 1')],
  ['revoked token envelope is wiped atomically', source.store.includes("token_ciphertext = ''") && source.store.includes('sources_disconnected AS')],
  ['execution requires an explicit OAuth verification posture', source.provider.includes('CONNECTOR_GOOGLE_OAUTH_VERIFICATION_UNPROVEN') && source.provider.includes("'pilot_test_users'") && source.provider.includes("'verified'")],
  ['readiness separates pilot canary from commercial authority', source.readiness.includes('connectorCanaryReady') && source.readiness.includes('connectorCommercialReady') && source.readiness.includes('commercial_authorization_ready')],
  ['provider catalog labels intended authority', source.registry.includes("credential_authority: 'dedicated_connector'")],
  ['machine API contract exposes start and complete', source.apiContract.includes('/api/v1/sources/oauth/:id/start') && source.apiContract.includes('/api/v1/sources/oauth/:id/complete')],
  ['pilot activation defaults disabled', /CONNECTOR_OAUTH_AUTHORITY_MODE\s*=\s*"disabled"/.test(source.pilotConfig)],
  ];
}

const checks = evaluate();

if (selfTest) {
  const controlGreen = checks.every(([, ok]) => ok);
  const mutantChecks = evaluate({
    provider: provider.replace("url.searchParams.set('code_challenge_method', 'S256');", ''),
  });
  const mutant = mutantChecks.find(([id]) => id === 'Google flow uses PKCE and offline incremental consent');
  const mutationObserved = mutant?.[1] === false;
  if (!controlGreen || !mutationObserved) {
    console.error(JSON.stringify({ status: 'FAIL', control_green: controlGreen, mutation_observed: mutationObserved }, null, 2));
    process.exit(1);
  }
  console.log('PASS connector OAuth authority self-test: unmutated control green; PKCE mutant observed red');
  process.exit(0);
}

const failures = checks.filter(([, ok]) => !ok).map(([id]) => id);
if (failures.length) {
  console.error(JSON.stringify({ status: 'FAIL', checks: checks.length, failures }, null, 2));
  process.exit(1);
}
const passed = checks.filter(([, ok]) => ok).length;
console.log(`PASS connector OAuth authority: ${passed}/${checks.length} controls`);
