#!/usr/bin/env node
// Hono-aware route and entry-authorization manifest emitter.
//
// The parser follows mounted Hono applications, including factory-created routers,
// from src/workers/index.ts. Every emitted route must inherit one explicit entry
// authorization policy; unknown mounts and conflicting duplicate policies fail closed.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parse } from '@babel/parser';

const argv = process.argv.slice(2);
const repoIdx = argv.indexOf('--repo');
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = repoIdx !== -1 ? resolve(argv[repoIdx + 1]) : resolve(HERE, '..');
const WORKERS = pjoin(REPO, 'src/workers');
const INDEX = pjoin(WORKERS, 'index.ts');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const GROUP_AUTH = Object.freeze({
  operationalRoutes: {
    policy: 'clerk_jwt_or_scoped_service_token',
    source: 'src/workers/index.ts: operationalRoutes clerkAuth(allowCanary, allowCustomerToken)',
    middleware: [{ helper: 'clerkAuth', path: '*', options: { allowCanary: true, allowCustomerToken: true } }],
  },
  eventsRoutes: {
    policy: 'clerk_jwt_org_optional_with_route_guard',
    source: 'src/workers/index.ts: eventsRoutes clerkAuth(requireOrg=false)',
    middleware: [{ helper: 'clerkAuth', path: '*', options: { requireOrg: false } }],
  },
  protectedRoutes: {
    policy: 'clerk_jwt_org_required',
    source: 'src/workers/index.ts: protectedRoutes clerkAuth()',
    middleware: [{ helper: 'clerkAuth', path: '*', options: {} }],
  },
  userRoutes: {
    policy: 'clerk_jwt_org_optional',
    source: 'src/workers/index.ts: userRoutes clerkAuth(requireOrg=false)',
    middleware: [{ helper: 'clerkAuth', path: '*', options: { requireOrg: false } }],
  },
  adminRoutes: {
    policy: 'clerk_jwt_admin',
    source: 'src/workers/index.ts: adminRoutes clerkAuth(requireOrg=false) + requireAdmin()',
    middleware: [
      { helper: 'clerkAuth', path: '*', options: { requireOrg: false } },
      { helper: 'requireAdmin', path: '*', options: {} },
    ],
  },
});

const DIRECT_AUTH = Object.freeze({
  healthRoute: {
    policy: 'public',
    source: 'src/workers/index.ts: explicit public mount',
    guard: { kind: 'explicit_public' },
  },
  // Stage-2 slice 1 (260806) · RFC 9728 protected-resource metadata — deliberately public and
  // cacheable: discovery documents are read BEFORE any credential exists, by definition.
  oauthDiscoveryRoute: {
    policy: 'public',
    source: 'src/workers/index.ts: explicit public mount (RFC 9728 well-known document)',
    guard: { kind: 'explicit_public' },
  },
  // Stage-2 second half (260806) · the PKCE AS. Metadata/register/authorize/token are public by
  // the OAuth protocol's nature (PKCE is the proof for public clients; authorize 400s rather than
  // redirecting on any client/redirect validation failure). /oauth/consent is Clerk-gated in-route
  // (clerkAuth + authorizeGovernedWrite('token:create') — the same gate as manual token minting).
  oauthAsRoute: {
    policy: 'public_with_abuse_controls',
    source: 'src/workers/routes/oauth-as.ts: PKCE-only public endpoints; consent clerk-gated via authorizeGovernedWrite(token:create)',
    guard: { kind: 'route_handler_call', helper: 'authorizeGovernedWrite' },
  },
  requestAccessRoute: {
    policy: 'public_with_abuse_controls',
    source: 'src/workers/index.ts: request-access rateLimit; src/workers/routes/request-access.ts: verifyTurnstile',
    guard: { kind: 'route_handler_call', helper: 'verifyTurnstile' },
    rootMiddleware: [{ helper: 'rateLimit', path: '/api/v1/request-access' }],
  },
  diagnoseRoute: {
    policy: 'clerk_jwt_operator_identity',
    source: 'src/workers/routes/diagnose.ts: requireOperator',
    guard: { kind: 'route_handler_call', helper: 'requireOperator' },
  },
  githubWebhookRoute: {
    policy: 'hmac_sha256_webhook',
    source: 'src/workers/routes/github-webhook.ts: verifyGithubSignature',
    guard: { kind: 'route_handler_call', helper: 'verifyGithubSignature' },
  },
  activityWebhookRoute: {
    policy: 'shared_secret_bearer',
    source: 'src/workers/routes/activity-webhook.ts: verifyActivityToken',
    guard: { kind: 'route_handler_call', helper: 'verifyActivityToken' },
  },
  investorPublicRoute: {
    policy: 'public',
    source: 'src/workers/index.ts: explicit public mount',
    guard: { kind: 'explicit_public' },
  },
  sessionRoute: {
    policy: 'clerk_jwt_session_state',
    source: 'src/workers/routes/session.ts: verifyClerkSessionToken',
    guard: { kind: 'route_handler_call', helper: 'verifyClerkSessionToken' },
  },
  mbpProjectionRoute: {
    policy: 'route_local_mixed',
    source: 'src/workers/routes/mbp-projection.ts: route-local authorization',
    guard: { kind: 'route_overrides' },
  },
});

const ROUTE_AUTH_OVERRIDES = Object.freeze({
  'GET /api/v1/mbp-projection': {
    policy: 'clerk_jwt_operator_identity',
    source: 'src/workers/routes/mbp-projection.ts: verifyMbpOwner',
    guard: { kind: 'route_handler_call', helper: 'verifyMbpOwner' },
  },
  'GET /api/v1/mbp-live-stream': {
    policy: 'clerk_jwt_operator_identity',
    source: 'src/workers/routes/mbp-projection.ts: verifyMbpOwner',
    guard: { kind: 'route_handler_call', helper: 'verifyMbpOwner' },
  },
  'GET /api/v1/mbp-operator-spaces': {
    policy: 'clerk_jwt_operator_identity',
    source: 'src/workers/routes/mbp-projection.ts: verifyMbpOwner',
    guard: { kind: 'route_handler_call', helper: 'verifyMbpOwner' },
  },
  'POST /api/v1/mbp-live-stream/ingest': {
    policy: 'shared_secret_bearer',
    source: 'src/workers/routes/mbp-projection.ts: verifyIngestToken',
    guard: { kind: 'route_handler_call', helper: 'verifyIngestToken' },
  },
  'POST /api/v1/mbp-projection/ingest': {
    policy: 'shared_secret_bearer',
    source: 'src/workers/routes/mbp-projection.ts: verifyIngestToken',
    guard: { kind: 'route_handler_call', helper: 'verifyIngestToken' },
  },
});

function joinPath(a, b) {
  if (!b || b === '/') return a || '/';
  const left = (a || '').replace(/\/+$/, '');
  const right = b.startsWith('/') ? b : '/' + b;
  return (left + right) || '/';
}

function normalize(path) {
  return path.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, ':id').replace(/\/+$/, '') || '/';
}

function literalString(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((part) => part.value.cooked ?? part.value.raw).join('');
  }
  return null;
}

function memberCall(node) {
  if (node?.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression' || node.callee.computed) return null;
  if (node.callee.object?.type !== 'Identifier' || node.callee.property?.type !== 'Identifier') return null;
  return { parent: node.callee.object.name, method: node.callee.property.name, args: node.arguments };
}

function identifierCall(node, expectedName) {
  return node?.type === 'CallExpression'
    && node.callee?.type === 'Identifier'
    && node.callee.name === expectedName;
}

function literalOptions(node) {
  if (node?.type !== 'ObjectExpression') return null;
  const result = {};
  for (const property of node.properties) {
    if (property.type !== 'ObjectProperty' || property.computed) return null;
    const key = property.key.type === 'Identifier' ? property.key.name : literalString(property.key);
    if (!key || property.value.type !== 'BooleanLiteral') return null;
    result[key] = property.value.value;
  }
  return result;
}

function sameOptions(call, expected) {
  if (call?.type !== 'CallExpression' || call.callee?.type !== 'Identifier') return false;
  if (Object.keys(expected).length === 0) return call.arguments.length === 0;
  if (call.arguments.length !== 1) return false;
  const actual = literalOptions(call.arguments[0]);
  if (!actual) return false;
  return JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(expected).sort());
}

function handlerCallsHelper(routeCall, helper) {
  let found = false;
  for (const handler of routeCall.args.slice(1)) {
    walkAst(handler, (node) => {
      if (identifierCall(node, helper)) found = true;
    });
  }
  return found;
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    if (Array.isArray(value)) for (const item of value) walkAst(item, visit);
    else if (value && typeof value === 'object') walkAst(value, visit);
  }
}

function parseSource(file) {
  return parse(readFileSync(file, 'utf-8'), {
    sourceType: 'module',
    plugins: ['typescript'],
  });
}

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, pjoin(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve local import ${specifier} from ${fromFile}`);
}

const moduleCache = new Map();
function inspectModule(file) {
  if (moduleCache.has(file)) return moduleCache.get(file);
  const ast = parseSource(file);
  const imports = new Map();
  const honoVars = new Set();
  const calls = [];
  const functions = new Map();

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      const target = resolveImport(file, statement.source.value);
      if (!target) continue;
      for (const specifier of statement.specifiers) {
        const imported = specifier.type === 'ImportSpecifier'
          ? (specifier.imported.name ?? specifier.imported.value)
          : specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*';
        imports.set(specifier.local.name, { file: target, imported });
      }
    }
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id) functions.set(declaration.id.name, declaration);
    if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        if (item.id?.type === 'Identifier' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(item.init?.type)) {
          functions.set(item.id.name, item.init);
        }
      }
    }
  }

  walkAst(ast.program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init?.type === 'NewExpression' && node.init.callee?.type === 'Identifier' && node.init.callee.name === 'Hono') {
      honoVars.add(node.id.name);
    }
    const call = memberCall(node);
    if (call) calls.push(call);
  });

  const info = { ast, imports, honoVars, calls, functions };
  moduleCache.set(file, info);
  return info;
}

function middlewareMatches(info, routerVar, expected) {
  return info.calls.some((call) => (
    call.parent === routerVar
    && call.method === 'use'
    && literalString(call.args[0]) === expected.path
    && identifierCall(call.args[1], expected.helper)
    && (expected.options === undefined || sameOptions(call.args[1], expected.options))
  ));
}

function validateGroupMiddleware(routerVar, auth, options) {
  const info = inspectModule(INDEX);
  for (const expected of auth.middleware) {
    let found = middlewareMatches(info, routerVar, expected);
    if (options.simulateGroupGuardRemoval && routerVar === 'operationalRoutes' && expected.helper === 'clerkAuth') {
      found = false;
    }
    if (!found) {
      throw new Error(
        `declared entry authorization is not source-bound: ${routerVar}.use('${expected.path}', ${expected.helper}(...))`,
      );
    }
  }
}

function validateExplicitPublicRouter(child) {
  const file = child.file ?? INDEX;
  const routerVar = child.imported ?? child.name;
  const info = inspectModule(file);
  if (info.calls.some((call) => call.parent === routerVar && call.method === 'use')) {
    throw new Error(`explicit-public router ${routerVar} now has middleware; reclassify its entry authorization`);
  }
}

function factoryRouter(file, factoryName) {
  const info = inspectModule(file);
  const fn = info.functions.get(factoryName);
  if (!fn) throw new Error(`factory ${factoryName} not found in ${file}`);
  const localHono = new Set();
  const returned = [];
  walkAst(fn.body, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init?.type === 'NewExpression' && node.init.callee?.type === 'Identifier' && node.init.callee.name === 'Hono') {
      localHono.add(node.id.name);
    }
    if (node.type === 'ReturnStatement' && node.argument?.type === 'Identifier') returned.push(node.argument.name);
  });
  const candidates = returned.filter((name) => localHono.has(name));
  if (candidates.length !== 1) throw new Error(`factory ${factoryName} must return exactly one local Hono router; found ${candidates.length}`);
  return candidates[0];
}

function childDescriptor(arg, info) {
  if (arg?.type === 'Identifier') {
    if (info.honoVars.has(arg.name)) return { kind: 'local_router', name: arg.name };
    const imported = info.imports.get(arg.name);
    if (imported) return { kind: 'imported_router', localName: arg.name, ...imported };
    throw new Error(`mounted router ${arg.name} is neither a local Hono app nor a local import`);
  }
  if (arg?.type === 'CallExpression' && arg.callee?.type === 'Identifier') {
    const imported = info.imports.get(arg.callee.name);
    if (imported) return { kind: 'factory', localName: arg.callee.name, ...imported };
    if (info.functions.has(arg.callee.name)) return { kind: 'factory', localName: arg.callee.name, file: null, imported: arg.callee.name };
  }
  throw new Error(`unsupported mounted-router expression type: ${arg?.type ?? 'missing'}`);
}

function authForRootMount(child, options) {
  const localName = child.name ?? child.localName;
  const groupPolicy = GROUP_AUTH[localName];
  if (groupPolicy) {
    validateGroupMiddleware(localName, groupPolicy, options);
    return groupPolicy;
  }
  const policy = DIRECT_AUTH[localName];
  if (!policy) throw new Error(`unknown entry authorization for app.route child ${localName}`);
  for (const expected of policy.rootMiddleware ?? []) {
    if (!middlewareMatches(inspectModule(INDEX), 'app', expected)) {
      throw new Error(
        `declared entry authorization is not source-bound: app.use('${expected.path}', ${expected.helper}(...))`,
      );
    }
  }
  if (policy.guard?.kind === 'explicit_public') validateExplicitPublicRouter(child);
  return policy;
}

function buildManifest(options = {}) {
  const routeSet = new Map();
  const visited = new Set();
  const leafRouters = new Set();
  let declaredFactoryMounts = 0;
  let resolvedFactoryMounts = 0;

  function addRoute(method, path, auth, router, routeCall) {
    const normalized = normalize(path);
    if (!normalized.startsWith('/api/v1')) return;
    const key = `${method} ${normalized}`;
    const override = ROUTE_AUTH_OVERRIDES[key];
    const applied = override ?? auth;
    if (!applied?.policy || applied.policy === 'route_local_mixed') {
      throw new Error(`unknown route authorization policy for ${key} (${router})`);
    }
    if (applied.guard?.kind === 'route_handler_call') {
      let found = handlerCallsHelper(routeCall, applied.guard.helper);
      if (options.simulateRouteGuardRemoval && key === 'GET /api/v1/mbp-projection') found = false;
      if (!found) {
        throw new Error(`declared route authorization is not source-bound: ${key} must call ${applied.guard.helper}`);
      }
    }
    const evidenceKind = applied.guard?.kind ?? (applied.middleware ? 'group_middleware' : 'unknown');
    const guardHelpers = applied.guard?.helper
      ? [applied.guard.helper]
      : (applied.middleware ?? []).map((entry) => entry.helper);
    const route = {
      method,
      path: normalized,
      auth_policy: applied.policy,
      auth_source: applied.source,
      auth_scope: 'entry',
      auth_evidence_kind: evidenceKind,
      auth_guard_helpers: guardHelpers,
      router,
    };
    const existing = routeSet.get(key);
    if (existing) throw new Error(`duplicate mounted route ${key}: ${existing.router} and ${route.router}`);
    routeSet.set(key, route);
  }

  function resolveRouter(file, routerVar, prefix, auth, ancestry = []) {
    const visitKey = `${file}#${routerVar}@${prefix}[${auth?.policy ?? 'root'}]`;
    if (ancestry.includes(visitKey)) throw new Error(`route-mount cycle: ${[...ancestry, visitKey].join(' -> ')}`);
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    const info = inspectModule(file);
    const routeCalls = info.calls.filter((call) => call.parent === routerVar && METHODS.has(call.method));
    if (routeCalls.length) leafRouters.add(`${file}#${routerVar}`);
    for (const call of routeCalls) {
      const subpath = literalString(call.args[0]);
      if (subpath === null) throw new Error(`dynamic route path on ${routerVar}.${call.method} in ${file}`);
      addRoute(
        call.method.toUpperCase(),
        joinPath(prefix, subpath),
        auth,
        `${file.replace(REPO + '/', '')}#${routerVar}`,
        call,
      );
    }

    for (const call of info.calls.filter((item) => item.parent === routerVar && item.method === 'route')) {
      const mountPrefix = literalString(call.args[0]);
      if (mountPrefix === null) throw new Error(`dynamic mount prefix on ${routerVar}.route in ${file}`);
      const child = childDescriptor(call.args[1], info);
      const childAuth = file === INDEX && routerVar === 'app' ? authForRootMount(child, options) : auth;
      if (!childAuth) throw new Error(`route mount ${routerVar} -> ${child.name ?? child.localName} has no entry authorization policy`);
      const fullPrefix = joinPath(prefix, mountPrefix);

      if (child.kind === 'local_router') {
        resolveRouter(file, child.name, fullPrefix, childAuth, [...ancestry, visitKey]);
      } else if (child.kind === 'imported_router') {
        resolveRouter(child.file, child.imported, fullPrefix, childAuth, [...ancestry, visitKey]);
      } else {
        declaredFactoryMounts += 1;
        if (options.simulateFactoryOmission) continue;
        const targetFile = child.file ?? file;
        const targetVar = factoryRouter(targetFile, child.imported);
        const before = routeSet.size;
        resolveRouter(targetFile, targetVar, fullPrefix, childAuth, [...ancestry, visitKey]);
        if (routeSet.size === before) throw new Error(`factory mount ${child.localName} emitted no API routes`);
        resolvedFactoryMounts += 1;
      }
    }
  }

  resolveRouter(INDEX, 'app', '', null);
  if (declaredFactoryMounts !== resolvedFactoryMounts) {
    throw new Error(`factory-mount coverage incomplete: declared=${declaredFactoryMounts}, resolved=${resolvedFactoryMounts}`);
  }

  const routes = [...routeSet.values()].sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
  if (options.simulateUnknownAuth && routes.length) routes[0].auth_policy = 'unknown';
  const unknown = routes.filter((route) => !route.auth_policy || route.auth_policy === 'unknown' || route.auth_policy === 'route_local_mixed');
  if (unknown.length) throw new Error(`authorization classification incomplete for ${unknown.length} routes`);

  const backed = [...new Set(routes.map((route) => route.path))].sort();
  const CONTRACT_VERSION = 'v1';
  const contractHash = createHash('sha256').update(routes.map((route) => `${route.method} ${route.path}`).join('\n')).digest('hex');
  const authorizationHash = createHash('sha256').update(routes.map((route) => (
    `${route.method} ${route.path} ${route.auth_policy} ${route.auth_source} ${route.auth_evidence_kind} ${route.auth_guard_helpers.join(',')}`
  )).join('\n')).digest('hex');
  const authPolicyCounts = Object.fromEntries(
    [...new Set(routes.map((route) => route.auth_policy))].sort().map((policy) => [policy, routes.filter((route) => route.auth_policy === policy).length]),
  );

  return {
    _comment: 'Generated by scripts/emit-routes-manifest.mjs from the mounted Hono graph. Every route carries a fail-closed entry authorization classification. Do not hand-edit.',
    _provenance: {
      generator: 'scripts/emit-routes-manifest.mjs',
      parser: '@babel/parser',
      authorization_evidence_scope: 'mounted entry policy plus declared middleware/handler-guard presence; not exhaustive in-handler role, entitlement, or RLS proof',
      contract_version: CONTRACT_VERSION,
      contract_hash: contractHash,
      authorization_hash: authorizationHash,
      leaf_router_count: leafRouters.size,
      factory_mount_count: resolvedFactoryMounts,
      route_count: routes.length,
      backed_count: backed.length,
      auth_classified_count: routes.length - unknown.length,
      auth_unknown_count: unknown.length,
      auth_policy_counts: authPolicyCounts,
    },
    backed,
    routes,
  };
}

function runSelfTest() {
  const manifest = buildManifest();
  const keys = new Set(manifest.routes.map((route) => `${route.method} ${route.path}`));
  for (const expected of ['GET /api/v1/mcp/rpc', 'POST /api/v1/mcp/rpc']) {
    if (!keys.has(expected)) throw new Error(`self-test expected factory route missing: ${expected}`);
  }
  if (manifest._provenance.auth_unknown_count !== 0 || manifest._provenance.auth_classified_count !== manifest._provenance.route_count) {
    throw new Error('self-test expected 100% entry-authorization classification');
  }

  const mutations = [
    '--simulate-factory-omission',
    '--simulate-unknown-auth',
    '--simulate-group-guard-removal',
    '--simulate-route-guard-removal',
  ];
  let mutationsObservedRed = 0;
  for (const mutation of mutations) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--repo', REPO, mutation], { encoding: 'utf-8' });
    if (child.status === 0) throw new Error(`self-test mutation did not turn RED: ${mutation}`);
    mutationsObservedRed += 1;
  }
  console.log(`route-manifest self-test PASS · ${manifest._provenance.auth_classified_count}/${manifest._provenance.route_count} classified · ${manifest._provenance.factory_mount_count} factory mount · ${mutationsObservedRed}/${mutations.length} mutations RED`);
}

if (argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

let manifest;
try {
  manifest = buildManifest({
    simulateFactoryOmission: argv.includes('--simulate-factory-omission'),
    simulateUnknownAuth: argv.includes('--simulate-unknown-auth'),
    simulateGroupGuardRemoval: argv.includes('--simulate-group-guard-removal'),
    simulateRouteGuardRemoval: argv.includes('--simulate-route-guard-removal'),
  });
} catch (error) {
  console.error(`route-manifest REFUSED · ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const cmpIdx = argv.indexOf('--compare');
if (cmpIdx !== -1) {
  const snap = JSON.parse(readFileSync(argv[cmpIdx + 1], 'utf-8'));
  const pinnedVersion = snap._provenance?.contract_version ?? snap.contract_version;
  const pinnedHash = snap._provenance?.contract_hash ?? snap.contract_hash;
  if (pinnedVersion && pinnedVersion !== manifest._provenance.contract_version) {
    console.log(`✗ contract_version drift: snapshot pins '${pinnedVersion}', backend emits '${manifest._provenance.contract_version}'`);
    process.exit(1);
  }
  if (pinnedHash && pinnedHash !== manifest._provenance.contract_hash) {
    console.log(`✗ contract_hash drift: snapshot pins ${pinnedHash.slice(0, 12)}…, backend emits ${manifest._provenance.contract_hash.slice(0, 12)}… — regenerate the consumer snapshot`);
    process.exit(1);
  }
  const theirs = new Set((snap.backed || []).map(normalize));
  const ours = new Set(manifest.backed);
  const inSnapNotBackend = [...theirs].filter((path) => !ours.has(path));
  const inBackendNotSnap = [...ours].filter((path) => !theirs.has(path));
  console.log(`>> compare · emitter backed: ${ours.size} · snapshot backed: ${theirs.size}`);
  if (inSnapNotBackend.length) for (const path of inSnapNotBackend) console.log(`     - ${path}`);
  if (inBackendNotSnap.length) for (const path of inBackendNotSnap) console.log(`     + ${path}`);
  if (!inSnapNotBackend.length && !inBackendNotSnap.length) console.log('   MATCH');
  process.exit(inSnapNotBackend.length ? 1 : 0);
}

const outIdx = argv.indexOf('--out');
const json = JSON.stringify(manifest, null, 2) + '\n';
if (outIdx !== -1) {
  writeFileSync(argv[outIdx + 1], json);
  console.error(`wrote ${manifest._provenance.backed_count} route templates (${manifest._provenance.route_count} method+path) to ${argv[outIdx + 1]}`);
} else {
  process.stdout.write(json);
}
