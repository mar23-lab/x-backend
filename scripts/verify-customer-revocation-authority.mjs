#!/usr/bin/env node
// verify-customer-revocation-authority.mjs — EXECUTED proof of the customer credential authority.
//
// WHAT THIS REPLACES. `scripts/verify-customer-revocation-end-to-end.mjs` defined
// `function authorize(identity, request)` INSIDE the gate, defined its fixtures INSIDE the gate, and
// then asserted that its own function returned the expected verdicts on its own fixtures: 20 of its
// 24 checks tested the gate's own code, its last check compared two hardcoded literals declared a
// few lines apart (unconditionally true), and production authorization was only string-marker
// grepped. It was named "end-to-end", it was BLOCKING in ci-local and therefore on every push, and
// production auth could have broken arbitrarily while it stayed green. It is the named instance
// META-GATE P-2 (verify-gate-self-reference.mjs) was built against.
//
// WHAT THIS DOES INSTEAD. It IMPORTS the shipped TypeScript and RUNS it. Every assertion below is
// about a symbol exported from `src/`; this file defines no authorization logic and no decision
// table of its own. Node 22's built-in type stripping plus a `module.registerHooks()` resolver
// (extensionless relative specifiers -> `.ts`, JSON -> `type: "json"`) loads the real modules with
// ZERO new dependencies. The seams are the ones production already has: `getCustomerTokenByHashRow`
// takes its `sql` tagged template as a PARAMETER, and `authorizeSpineWrite` reads its Sql/DAL off
// the Hono context — so a recording stub observes the real statements and the real decisions
// without a database.
//
// HONEST SCOPE — this is NOT end-to-end and is no longer named as if it were. It proves:
//   A. the customer-token store resolves ONLY live (non-revoked) rows, binds its parameters,
//      refuses malformed input before touching the database, scopes revoke/list to a workspace, and
//      persists only the SHA-256 of a minted credential;
//   B. the governed-write authority that gates the mcp-gateway write surfaces returns the expected
//      verdicts for viewer / operator / no-role / customer service principal / platform canary, and
//      the read-side projection the UI renders agrees with enforcement for EVERY action.
// It does NOT drive HTTP, does not exercise the Clerk JWT middleware, and does not touch Postgres.
// Those live in the workers vitest pool (`src/workers/__tests__/auth.test.ts`,
// `spine-authority.test.ts`, `route-auth-coverage.test.ts`) and in the live-RLS proof.
//
// SELF-TEST. `--self-test` copies `src/` to a scratch tree, applies four mutants to the REAL
// production sources, and asserts this gate goes RED on each one via a child process — plus an
// unmutated CONTROL that must stay green, so "always red" cannot masquerade as "detects drift".
//
// EXIT CODES.  0 = measured clean   1 = measured, failed   2 = COULD NOT MEASURE
// Exit 2 is distinct on purpose: "the production modules would not load" must never render as clean.
//
//   node scripts/verify-customer-revocation-authority.mjs
//   node scripts/verify-customer-revocation-authority.mjs --json
//   node scripts/verify-customer-revocation-authority.mjs --self-test
//   node scripts/verify-customer-revocation-authority.mjs --src-root=<dir>   # self-test aims it here

import { createHash } from 'node:crypto';
import { existsSync, cpSync, readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const selfTest = argv.includes('--self-test');
const rootArg = argv.find((a) => a.startsWith('--src-root='));
const SRC = rootArg ? resolve(REPO, rootArg.slice('--src-root='.length)) : join(REPO, 'src');

const STORE_REL = 'workers/dal/customer-token-store.ts';
const AUTHORITY_REL = 'workers/lib/spine-authority.ts';
const PERMISSIONS_REL = 'workers/lib/permissions.ts';
const SCOPES_REL = 'workers/lib/customer-connector-scopes.ts';

function cannotMeasure(reason) {
  if (asJson) {
    console.log(JSON.stringify({ schema_id: 'xlooop.customer_revocation_authority.v2', status: 'CANNOT_MEASURE', reason }, null, 2));
  } else {
    console.error(`verify-customer-revocation-authority · CANNOT MEASURE — ${reason}`);
  }
  process.exit(2);
}

// =================================================================================================
// LOADING THE SHIPPED CODE
// =================================================================================================
// Node 22 strips TypeScript types natively. What it will not do is guess an extension, and the
// worker sources import each other extensionlessly (`from './shared-helpers'`) because the Wrangler
// bundler resolves that. One resolver hook closes the gap for the whole tree. JSON imports need an
// explicit attribute under ESM; spine-authority reaches a JSON catalog transitively.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && !specifier.endsWith('.json')) {
      const base = dirname(fileURLToPath(context.parentURL));
      for (const ext of ['.ts', '.mts', '.mjs', '.js', '/index.ts']) {
        const candidate = resolve(base, specifier + ext);
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    const resolved = nextResolve(specifier, context);
    if (resolved.url.endsWith('.json')) return { ...resolved, importAttributes: { type: 'json' } };
    return resolved;
  },
});

async function loadShipped(relative) {
  const absolute = join(SRC, relative);
  if (!existsSync(absolute)) cannotMeasure(`shipped module missing: ${absolute}`);
  try {
    return await import(pathToFileURL(absolute).href);
  } catch (error) {
    cannotMeasure(`shipped module ${relative} would not load: ${error && error.message}`);
    return null;
  }
}

// =================================================================================================
// RECORDING SEAMS — the transport, not the subject
// =================================================================================================
// A Neon tagged template. The join marker draws the distinction that matters for injection: text the
// caller BUILT versus a value it BOUND. Nothing here decides anything; the shipped code does.
const PARAM_MARKER = ' PARAM ';
function recordingSql(rowsFor) {
  const statements = [];
  const sql = (strings, ...params) => {
    const text = strings.join(PARAM_MARKER).replace(/\s+/g, ' ').trim();
    statements.push({ text, params });
    return Promise.resolve(rowsFor ? rowsFor(text, params) : []);
  };
  return { sql, statements };
}

// A Hono-shaped context: the shipped authority reads `auth` / `sql` / `dal` off it and nothing else.
function honoContext(auth, env, extra) {
  const bag = new Map(Object.entries({ auth, ...(extra || {}) }));
  return { env: env || {}, get: (key) => bag.get(key), set: (key, value) => bag.set(key, value) };
}

const WRITE_SURFACES = ['evidence:submit', 'tool_event:report', 'approval:request'];

let failed = 0;
const ledger = [];
function check(id, ok, detail) {
  ledger.push(ok ? { id, status: 'PASS' } : { id, status: 'FAIL', detail });
  if (!ok) failed += 1;
}

// =================================================================================================
// SELF-TEST — mutate the SHIPPED sources, observe a red
// =================================================================================================
// Every mutant is a one-line edit to real production code. A mutant this gate does not notice is a
// hole in the gate; the unmutated control proves the harness can still report green.
const MUTANTS = [
  {
    id: 'revocation_predicate_removed',
    file: STORE_REL,
    find: 'WHERE token.token_sha256 = ${tokenSha256} AND token.revoked_at IS NULL',
    replace: 'WHERE token.token_sha256 = ${tokenSha256}',
    expects: 'live_row_lookup_excludes_revoked',
  },
  {
    id: 'malformed_hash_guard_removed',
    file: STORE_REL,
    find: 'if (!/^[a-f0-9]{64}$/.test(tokenSha256)) return null;',
    replace: '',
    expects: 'malformed_credential_never_reaches_the_database',
  },
  {
    id: 'write_role_gate_opened',
    file: PERMISSIONS_REL,
    find: "return role === 'owner' || role === 'operator';",
    replace: 'return true;',
    expects: 'viewer_denied_on_mcp_write_surfaces',
  },
  {
    id: 'customer_token_exempted_from_enforcement',
    file: AUTHORITY_REL,
    find: "const isPlatformService = !!auth?.service_principal && auth.service_principal !== 'customer_token';",
    replace: 'const isPlatformService = !!auth?.service_principal;',
    expects: 'customer_service_principal_is_not_exempt_from_entitlement',
  },
  {
    id: 'delegated_membership_epoch_binding_removed',
    file: STORE_REL,
    find: 'AND member.activated_at = token.issuer_membership_activated_at',
    replace: 'AND member.activated_at IS NOT NULL',
    expects: 'delegated_authority_binds_membership_activation',
  },
  {
    id: 'evidence_action_scope_remapped',
    file: SCOPES_REL,
    find: "return 'write:evidence';",
    replace: "return 'read:evidence';",
    expects: 'explicit_action_scope_mapping',
  },
];

// A child that exits 2 has a `reason`; one that exits 1 has red checks. Surface whichever exists —
// an undiagnosable control failure is how a self-test gets deleted instead of fixed.
function describeRun(run) {
  try {
    const parsed = JSON.parse(run.stdout);
    if (parsed.reason) return parsed.reason;
    if (Array.isArray(parsed.checks)) {
      return parsed.checks.filter((entry) => entry.status === 'FAIL').map((entry) => entry.id).join(', ') || 'no red checks reported';
    }
  } catch { /* fall through to raw output */ }
  return (run.stderr || run.stdout || '').trim().split('\n').slice(-3).join(' | ') || '(no output)';
}

function runSelfTest() {
  // Scratch layout, learned the hard way while building this:
  //   - it must NOT live under node_modules/ — Node refuses to strip types for files under any
  //     node_modules path, so the mirror loaded but reported CANNOT_MEASURE (exit 2) and the control
  //     caught it;
  //   - it needs a `node_modules` SYMLINK so bare specifiers (`hono`, `@neondatabase/serverless`)
  //     still resolve;
  //   - it needs `docs/contracts/` mirrored too, because role-skill-catalog-loader.ts imports
  //     `../../../docs/contracts/role-skill-catalog.json` and that specifier is resolved relative to
  //     the MIRROR, not the repository.
  const scratch = mkdtempSync(join(tmpdir(), 'xlooop-revocation-authority-mutants-'));
  const controls = [];
  const observed = [];
  try {
    const mirror = join(scratch, 'src');
    cpSync(join(REPO, 'src'), mirror, { recursive: true });
    cpSync(join(REPO, 'docs', 'contracts'), join(scratch, 'docs', 'contracts'), { recursive: true });
    symlinkSync(join(REPO, 'node_modules'), join(scratch, 'node_modules'), 'dir');

    // CONTROL — an unmutated mirror must be GREEN. Without this, a gate that always fails would
    // "detect" every mutant and prove nothing at all.
    const control = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--src-root=${mirror}`, '--json'], { encoding: 'utf8' });
    if (control.status !== 0) {
      controls.push(
        `unmutated CONTROL mirror exited ${control.status} (expected 0) — the harness cannot report green, so no mutant result means anything. `
        + `Detail: ${describeRun(control)}`,
      );
    }

    for (const mutant of MUTANTS) {
      const target = join(mirror, mutant.file);
      const original = readFileSync(target, 'utf8');
      if (!original.includes(mutant.find)) {
        controls.push(`mutant ${mutant.id}: anchor no longer present in ${mutant.file} — this control is STALE and proves nothing`);
        continue;
      }
      writeFileSync(target, original.replace(mutant.find, mutant.replace));
      const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--src-root=${mirror}`, '--json'], { encoding: 'utf8' });
      writeFileSync(target, original);

      if (run.status !== 1) {
        controls.push(`mutant ${mutant.id}: expected exit 1 (measured, failed), got ${run.status}. Detail: ${describeRun(run)}`);
        continue;
      }
      let report = null;
      try { report = JSON.parse(run.stdout); } catch { /* reported below */ }
      const red = report && Array.isArray(report.checks)
        ? report.checks.filter((entry) => entry.status === 'FAIL').map((entry) => entry.id)
        : [];
      if (!red.includes(mutant.expects)) {
        controls.push(`mutant ${mutant.id}: exited 1 but "${mutant.expects}" was not among the red checks [${red.join(', ')}] — it failed for the wrong reason`);
        continue;
      }
      observed.push(`${mutant.id} -> exit 1 via ${mutant.expects}`);
      console.log(`  observed red   ${mutant.id.padEnd(46)} exit=1  ${mutant.expects}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (controls.length) {
    console.error('\nverify-customer-revocation-authority --self-test FAIL');
    for (const problem of controls) console.error(`  x ${problem}`);
    process.exit(1);
  }
  console.log(`\nverify-customer-revocation-authority — self-test PASS (${observed.length} mutants observed red, unmutated control green)`);
  process.exit(0);
}

if (selfTest) runSelfTest();

// =================================================================================================
// A · CUSTOMER CREDENTIAL REVOCATION AUTHORITY — the shipped store, executed
// =================================================================================================
const store = await loadShipped(STORE_REL);
for (const name of ['getCustomerTokenByHashRow', 'revokeCustomerTokenRow', 'listCustomerTokensRow', 'createCustomerTokenRow', 'hashToken']) {
  if (typeof store[name] !== 'function') cannotMeasure(`${STORE_REL} no longer exports ${name}`);
}

const WELL_FORMED_HASH = 'a'.repeat(64);

// The revoked case exactly as production experiences it: the row still exists in the table, but the
// live-row query does not return it, so the lookup must resolve to null and the request falls
// through to Clerk verification and a 401.
const revokedProbe = recordingSql(() => []);
const revokedOutcome = await store.getCustomerTokenByHashRow(revokedProbe.sql, WELL_FORMED_HASH);
const lookupStatement = revokedProbe.statements[0] || { text: '', params: [] };

check(
  'live_row_lookup_excludes_revoked',
  /revoked_at\s+IS\s+NULL/i.test(lookupStatement.text),
  `the statement the shipped lookup actually built carries no "revoked_at IS NULL" constraint — a revoked credential would still resolve to an AuthContext. Observed: ${lookupStatement.text || '(no statement issued)'}`,
);
check(
  'revoked_credential_resolves_to_null',
  revokedOutcome === null,
  `with no live row the shipped lookup returned ${JSON.stringify(revokedOutcome)}; it must be null so clerkAuth falls through to a 401`,
);
check(
  'credential_hash_is_a_bound_parameter',
  lookupStatement.params.includes(WELL_FORMED_HASH) && !lookupStatement.text.includes(WELL_FORMED_HASH),
  'the credential hash was interpolated into the statement text instead of bound as a parameter',
);

const delegatedActivatedAt = '2026-08-10T00:00:00.000Z';
const delegatedProbe = recordingSql(() => [{
  id: 'tok_delegated', workspace_id: 'ws_owner', role: 'viewer', label: 'delegated',
  packet_prefix: 'pkt-owner-', scopes: ['read:session', 'read:packets'],
  authority_mode: 'delegated_user', issuer_membership_activated_at: delegatedActivatedAt,
  issuer_membership_active: false, created_by: 'usr_delegate', created_at: delegatedActivatedAt,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: null,
  revoked_by: null, last_used_at: null,
}]);
const delegatedOutcome = await store.getCustomerTokenByHashRow(delegatedProbe.sql, WELL_FORMED_HASH);
const delegatedStatement = delegatedProbe.statements[0] || { text: '', params: [] };
check(
  'delegated_authority_requires_active_membership',
  delegatedOutcome?.authority_mode === 'delegated_user' && delegatedOutcome.issuer_membership_active === false,
  `the shipped store did not preserve an inactive delegated-membership verdict: ${JSON.stringify(delegatedOutcome)}`,
);
check(
  'delegated_authority_binds_membership_activation',
  /workspace_members/i.test(delegatedStatement.text)
    && /status\s*=\s*'active'/i.test(delegatedStatement.text)
    && /removed_at\s+IS\s+NULL/i.test(delegatedStatement.text)
    && /activated_at\s*=\s*token\.issuer_membership_activated_at/i.test(delegatedStatement.text),
  `delegated lookup must bind workspace, issuer, active state, removal state, and the exact membership activation epoch. Observed: ${delegatedStatement.text || '(no statement issued)'}`,
);

const malformedProbe = recordingSql(() => []);
const malformedOutcome = await store.getCustomerTokenByHashRow(malformedProbe.sql, "not-a-hash' OR 1=1 --");
check(
  'malformed_credential_never_reaches_the_database',
  malformedProbe.statements.length === 0 && malformedOutcome === null,
  `a malformed credential issued ${malformedProbe.statements.length} statement(s) and returned ${JSON.stringify(malformedOutcome)}; it must be refused before any database round trip`,
);

const revokeProbe = recordingSql(() => [{ id: 'tok_1' }]);
await store.revokeCustomerTokenRow(revokeProbe.sql, 'ws_owner', 'tok_1', 'usr_admin').catch(() => {});
const revokeStatement = revokeProbe.statements[0] || { text: '', params: [] };
check(
  'revoke_is_workspace_scoped',
  revokeStatement.params.includes('ws_owner') && /workspace_id/i.test(revokeStatement.text),
  `the shipped revoke did not bind the workspace as a predicate parameter — one tenant could revoke another tenant's credential. Observed: ${revokeStatement.text || '(no statement issued)'}`,
);

const listProbe = recordingSql(() => []);
await store.listCustomerTokensRow(listProbe.sql, 'ws_owner').catch(() => {});
const listStatement = listProbe.statements[0] || { text: '', params: [] };
check(
  'list_is_workspace_scoped',
  listStatement.params.includes('ws_owner') && /workspace_id/i.test(listStatement.text),
  `the shipped list did not bind the workspace as a predicate parameter — it would enumerate every tenant's credentials. Observed: ${listStatement.text || '(no statement issued)'}`,
);

const RAW_SECRET = 'xlk_raw_secret_never_persist_me';
const mintedDigest = await store.hashToken(RAW_SECRET);
const mintProbe = recordingSql(() => [{ id: 'tok_new' }]);
await store.createCustomerTokenRow(mintProbe.sql, {
  workspace_id: 'ws_owner',
  token_sha256: mintedDigest,
  role: 'viewer',
  label: 'probe',
  packet_prefix: 'pkt-probe-',
  scopes: ['read:session', 'read:packets'],
  authority_mode: 'delegated_user',
  issuer_membership_activated_at: delegatedActivatedAt,
  created_by: 'usr_admin',
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
}).catch(() => {});
const mintTrace = JSON.stringify(mintProbe.statements);
check(
  'mint_persists_only_the_digest',
  mintProbe.statements.length > 0 && !mintTrace.includes(RAW_SECRET) && mintTrace.includes(mintedDigest),
  'the shipped mint path put the raw credential on the wire — only its SHA-256 may ever be persisted',
);
check(
  'digest_agrees_with_an_independent_sha256',
  mintedDigest === createHash('sha256').update(RAW_SECRET).digest('hex'),
  `the shipped hashToken produced ${mintedDigest}, which is not the SHA-256 of the input as computed independently by node:crypto`,
);
check(
  'mint_persists_explicit_scopes',
  mintTrace.includes('read:session') && mintTrace.includes('read:packets')
    && mintTrace.includes('delegated_user') && mintTrace.includes(delegatedActivatedAt),
  'the shipped mint path did not bind explicit action scopes, authority mode, and membership activation epoch',
);

// =================================================================================================
// A2 · EXPLICIT CONNECTOR ACTION SCOPES — the shipped catalog, executed
// =================================================================================================
const scopeCatalog = await loadShipped(SCOPES_REL);
for (const name of ['resolveRequestedCustomerScopes', 'requiredCustomerScope', 'CUSTOMER_CONNECTOR_READ_SCOPES', 'CUSTOMER_CONNECTOR_OPERATOR_SCOPES']) {
  if (scopeCatalog[name] === undefined) cannotMeasure(`${SCOPES_REL} no longer exports ${name}`);
}
const expectedWriteScopes = [
  ['POST', '/api/v1/evidence', 'write:evidence'],
  ['POST', '/api/v1/tool-events', 'write:tool_events'],
  ['POST', '/api/v1/approvals', 'write:approval_requests'],
];
check(
  'explicit_action_scope_mapping',
  expectedWriteScopes.every(([method, path, scope]) => scopeCatalog.requiredCustomerScope(method, path) === scope),
  `write routes do not map to their explicit action scopes: ${JSON.stringify(expectedWriteScopes.map(([method, path]) => [method, path, scopeCatalog.requiredCustomerScope(method, path)]))}`,
);
const disabledOperator = scopeCatalog.resolveRequestedCustomerScopes('operator', false);
const enabledOperator = scopeCatalog.resolveRequestedCustomerScopes('operator', true);
const unknownScope = scopeCatalog.resolveRequestedCustomerScopes('read:session write:unknown', true);
check(
  'operator_scopes_require_activation',
  disabledOperator.ok === false
    && enabledOperator.ok === true
    && enabledOperator.role === 'operator'
    && expectedWriteScopes.every(([, , scope]) => enabledOperator.scopes.includes(scope)),
  `operator scope activation contract drifted: disabled=${JSON.stringify(disabledOperator)}, enabled=${JSON.stringify(enabledOperator)}`,
);
check(
  'unknown_scope_fails_closed',
  unknownScope.ok === false,
  `an unknown action scope was accepted: ${JSON.stringify(unknownScope)}`,
);

// =================================================================================================
// B · GOVERNED-WRITE AUTHORITY FOR THE MCP WRITE SURFACES — the shipped authority, executed
// =================================================================================================
const authority = await loadShipped(AUTHORITY_REL);
for (const name of ['authorizeSpineWrite', 'projectSpineAuthority', 'SPINE_ACTIONS']) {
  if (authority[name] === undefined) cannotMeasure(`${AUTHORITY_REL} no longer exports ${name}`);
}

const viewerVerdicts = [];
const operatorVerdicts = [];
const anonymousVerdicts = [];
for (const action of WRITE_SURFACES) {
  viewerVerdicts.push(await authority.authorizeSpineWrite(honoContext({ role: 'viewer', user_id: 'u_v', workspace_id: 'ws_a' }), action));
  operatorVerdicts.push(await authority.authorizeSpineWrite(honoContext({ role: 'operator', user_id: 'u_o', workspace_id: 'ws_a' }), action));
  anonymousVerdicts.push(await authority.authorizeSpineWrite(honoContext({ user_id: 'u_x', workspace_id: 'ws_a' }), action));
}

check(
  'viewer_denied_on_mcp_write_surfaces',
  viewerVerdicts.every((verdict) => verdict.allowed === false),
  `the shipped authority allowed a viewer to write: ${JSON.stringify(viewerVerdicts)}`,
);
check(
  'operator_allowed_on_mcp_write_surfaces',
  operatorVerdicts.every((verdict) => verdict.allowed === true),
  `the shipped authority denied an operator: ${JSON.stringify(operatorVerdicts)} — an authority that denies everyone proves nothing by denying a viewer`,
);
check(
  'absent_role_fails_closed',
  anonymousVerdicts.every((verdict) => verdict.allowed === false),
  `the shipped authority allowed a caller carrying no role at all: ${JSON.stringify(anonymousVerdicts)}`,
);

// The 260720 entitlement flip: CUSTOMER agent credentials are entitlement-gated, PLATFORM canary
// principals keep the legacy path. Stage-0 MCP unblock (260806) re-based the mechanism: a customer
// token's entitlement is ISSUANCE-DERIVED (buildCustomerTokenPrincipal — zero DB statements, so the
// old statement-count distinguisher no longer separates the paths). The behavioural distinguisher
// that CANNOT pass on the legacy role-only path is the ACTION AXIS: legacy canWrite('operator')
// is action-blind and would allow signoff:decide, while the issuance entitlement structurally
// denies decide-class actions (deny-wins) and allows only the report class. So: an operator token
// must be ALLOWED to submit evidence AND DENIED sign-off with reason 'action_denied' — the pair is
// unreachable from the legacy path in either direction.
const enforcedEnv = { ENTITLEMENT_ENFORCEMENT: 'on' };
const operatingMode = { getOperatingMode: async () => 'operator' };

const customerProbe = recordingSql(() => []);
const customerCtx = () => honoContext(
  { role: 'operator', user_id: 'u_c', workspace_id: 'ws_a', service_principal: 'customer_token' },
  enforcedEnv,
  { sql: customerProbe.sql, dal: operatingMode },
);
const customerReportVerdict = await authority.authorizeSpineWrite(customerCtx(), 'evidence:submit');
const customerDecideVerdict = await authority.authorizeSpineWrite(customerCtx(), 'signoff:decide');
check(
  'customer_service_principal_is_not_exempt_from_entitlement',
  customerReportVerdict.allowed === true
    && customerDecideVerdict.allowed === false
    && customerDecideVerdict.reason === 'action_denied',
  `with enforcement on, a customer credential must ride the issuance entitlement — report-class allowed, decide-class denied by the action list. Got evidence:submit ${JSON.stringify(customerReportVerdict)}, signoff:decide ${JSON.stringify(customerDecideVerdict)} — the legacy role-only path would allow BOTH`,
);

const canaryProbe = recordingSql(() => []);
const canaryVerdict = await authority.authorizeSpineWrite(
  honoContext(
    { role: 'operator', user_id: 'u_k', workspace_id: 'ws_a', service_principal: 'canary_read' },
    enforcedEnv,
    { sql: canaryProbe.sql, dal: operatingMode },
  ),
  'evidence:submit',
);
check(
  'platform_canary_principal_keeps_the_legacy_path',
  canaryProbe.statements.length === 0 && canaryVerdict.allowed === true,
  `the platform canary resolved entitlement (${canaryProbe.statements.length} statement(s), verdict ${JSON.stringify(canaryVerdict)}) — it carries no entitlement, so this blinds deploy verification`,
);

// The read side the UI renders must agree with the write side the server enforces, for every action.
// An affordance that contradicts enforcement is either a 403 on an enabled control or a silent
// success behind a hidden one.
const projected = await authority.projectSpineAuthority(honoContext({ role: 'viewer', user_id: 'u_v', workspace_id: 'ws_a' }));
const drift = [];
for (const action of authority.SPINE_ACTIONS) {
  const enforcedVerdict = await authority.authorizeSpineWrite(honoContext({ role: 'viewer', user_id: 'u_v', workspace_id: 'ws_a' }), action);
  if (enforcedVerdict.allowed !== projected.allowed_actions.includes(action)) drift.push(action);
}
check(
  'ui_projection_agrees_with_enforcement_for_every_action',
  authority.SPINE_ACTIONS.length > 0 && drift.length === 0,
  `projection and enforcement disagree on: ${drift.join(', ')} — an enabled control that 403s, or a hidden one that succeeds`,
);

// =================================================================================================
// REPORT
// =================================================================================================
const report = {
  schema_id: 'xlooop.customer_revocation_authority.v2',
  status: failed ? 'FAIL' : 'PASS',
  subject: 'shipped modules under src/ — this gate defines no authorization logic of its own',
  modules_executed: [STORE_REL, SCOPES_REL, AUTHORITY_REL],
  src_root: SRC,
  checks: ledger,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('\n  CUSTOMER CREDENTIAL AUTHORITY — shipped code, executed');
  console.log('  ' + '-'.repeat(78));
  for (const entry of ledger) {
    console.log('  ' + entry.status.padEnd(6) + '  ' + entry.id + (entry.detail ? '\n            ' + entry.detail : ''));
  }
  console.log('  ' + '-'.repeat(78));
  console.log(`  ${report.status}  ${ledger.length} checks executed against ${STORE_REL} + ${SCOPES_REL} + ${AUTHORITY_REL}\n`);
}
process.exit(failed ? 1 : 0);
