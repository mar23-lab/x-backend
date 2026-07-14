#!/usr/bin/env node
// scripts/emit-routes-manifest.mjs · Hono-aware backend route manifest emitter
//
// Walks the Hono app in src/workers/index.ts and every mounted sub-app in
// src/workers/routes/*.ts, resolves each route's FULL path (prefix chain + relative
// declaration), and emits the deterministic set of /api/v1 route templates as JSON.
//
// WHY: x-ai-front's F5 gate (verify-fe-routes-resolve.mjs) checks every frontend /api/v1
// route resolves to a real backend route. Its allowlist was hand-verified because a grep of
// /api/v1 literals MISSES Hono relative sub-routes (declared like
// `modelRuntimesRoute.put('/model-runtimes/default')` and mounted under /api/v1 in index.ts).
// This emitter resolves those relatives deterministically so the FE snapshot can be regenerated.
//
// Usage:
//   node scripts/emit-routes-manifest.mjs                 # print JSON to stdout
//   node scripts/emit-routes-manifest.mjs --out FILE      # write JSON to FILE
//   node scripts/emit-routes-manifest.mjs --compare FILE  # diff backed[] vs FILE's backed[]; exit 1 on drift
//   node scripts/emit-routes-manifest.mjs --repo DIR      # resolve routes from DIR instead of this repo

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const repoIdx = argv.indexOf('--repo');
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = repoIdx !== -1 ? resolve(argv[repoIdx + 1]) : resolve(HERE, '..');
const WORKERS = pjoin(REPO, 'src/workers');
const INDEX = pjoin(WORKERS, 'index.ts');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Join a mount prefix with a sub-path, Hono-style. '/' and '' are no-ops.
function joinPath(a, b) {
  if (!b || b === '/') return a || '/';
  const left = (a || '').replace(/\/+$/, '');
  const right = b.startsWith('/') ? b : '/' + b;
  return (left + right) || '/';
}
// Normalize path params to :id (matches the FE gate's normalization).
function normalize(p) {
  return p.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, ':id').replace(/\/+$/, '') || '/';
}

const indexSrc = readFileSync(INDEX, 'utf-8');

// Import map: `import { xRoute } from './routes/x'` -> xRoute => absolute file.
const importMap = new Map();
for (const m of indexSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.\/routes\/[^'"]+)['"]/g)) {
  const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
  const file = pjoin(WORKERS, m[2].replace(/^\.\//, '') + '.ts');
  for (const n of names) importMap.set(n, file);
}

// Intermediate Hono wrappers declared in index.ts: `const X = new Hono...`.
const honoVars = new Set();
for (const m of indexSrc.matchAll(/const\s+(\w+)\s*=\s*new\s+Hono\b/g)) honoVars.add(m[1]);

// Mount edges: `PARENT.route('PREFIX', CHILD)` with CHILD a bare identifier (skip factory calls).
const edges = [];
for (const m of indexSrc.matchAll(/(\w+)\.route\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g)) edges.push({ parent: m[1], prefix: m[2], child: m[3] });

// Resolve each mounted router's full prefix by walking from `app` (prefix '').
const leafPrefixes = [];
const seen = new Set();
function walk(node, prefix) {
  for (const e of edges.filter((x) => x.parent === node)) {
    const full = joinPath(prefix, e.prefix);
    const key = e.child + '@' + full;
    if (seen.has(key)) continue;
    seen.add(key);
    if (honoVars.has(e.child)) walk(e.child, full);
    else if (importMap.has(e.child)) leafPrefixes.push({ routerVar: e.child, file: importMap.get(e.child), prefix: full });
  }
}
walk('app', '');

// Parse each leaf file for `<routerVar>.<method>('<path>')` and resolve full paths.
const routeSet = new Map();
for (const { routerVar, file, prefix } of leafPrefixes) {
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf-8');
  const re = new RegExp(`\\b${routerVar}\\.(${METHODS.join('|')})\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  for (const m of src.matchAll(re)) {
    const method = m[1].toUpperCase();
    const path = normalize(joinPath(prefix, m[2]));
    if (!path.startsWith('/api/v1')) continue;
    routeSet.set(`${method} ${path}`, { method, path });
  }
}

const routes = [...routeSet.values()].sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
const backed = [...new Set(routes.map((r) => r.path))].sort();
// C0.3 (260713, cutover program): the manifest is now a VERSIONED contract surface. contract_hash is
// sha256 over the sorted "METHOD path" strings — deterministic, commit-independent — so a consumer
// (x-ai-front's snapshot, the x-backend parity gates) can pin "contract v1 @ <hash>" and any route
// add/remove/rename changes the hash. Bump contract_version only on a BREAKING contract redefinition.
const CONTRACT_VERSION = 'v1';
const contractHash = createHash('sha256').update(routes.map((r) => `${r.method} ${r.path}`).join('\n')).digest('hex');
const manifest = {
  _comment: 'Generated by scripts/emit-routes-manifest.mjs — the deterministic /api/v1 route surface of this Hono backend. Consumed by x-ai-front verify-fe-routes-resolve.mjs. Do not hand-edit.',
  _provenance: { generator: 'scripts/emit-routes-manifest.mjs', contract_version: CONTRACT_VERSION, contract_hash: contractHash, leaf_router_count: leafPrefixes.length, route_count: routes.length, backed_count: backed.length },
  backed,
  routes,
};

const cmpIdx = argv.indexOf('--compare');
if (cmpIdx !== -1) {
  const snap = JSON.parse(readFileSync(argv[cmpIdx + 1], 'utf-8'));
  // C0.3: when the snapshot carries contract pins, enforce them (older snapshots without pins still
  // compare on backed[] alone — backward-compatible).
  const pinnedVersion = snap._provenance?.contract_version ?? snap.contract_version;
  const pinnedHash = snap._provenance?.contract_hash ?? snap.contract_hash;
  if (pinnedVersion && pinnedVersion !== CONTRACT_VERSION) {
    console.log(`✗ contract_version drift: snapshot pins '${pinnedVersion}', backend emits '${CONTRACT_VERSION}'`);
    process.exit(1);
  }
  if (pinnedHash && pinnedHash !== contractHash) {
    console.log(`✗ contract_hash drift: snapshot pins ${pinnedHash.slice(0, 12)}…, backend emits ${contractHash.slice(0, 12)}… — regenerate the consumer snapshot`);
    process.exit(1);
  }
  const theirs = new Set((snap.backed || []).map(normalize));
  const ours = new Set(backed);
  const inSnapNotBackend = [...theirs].filter((p) => !ours.has(p));
  const inBackendNotSnap = [...ours].filter((p) => !theirs.has(p));
  console.log(`>> compare · emitter backed: ${ours.size} · snapshot backed: ${theirs.size}`);
  if (inSnapNotBackend.length) { console.log(`   IN SNAPSHOT, NOT IN BACKEND (${inSnapNotBackend.length}) [would be a FE phantom]:`); for (const p of inSnapNotBackend) console.log(`     - ${p}`); }
  if (inBackendNotSnap.length) { console.log(`   IN BACKEND, NOT IN SNAPSHOT (${inBackendNotSnap.length}) [backend-only routes]:`); for (const p of inBackendNotSnap.slice(0, 40)) console.log(`     + ${p}`); if (inBackendNotSnap.length > 40) console.log(`     ... +${inBackendNotSnap.length - 40} more`); }
  if (!inSnapNotBackend.length && !inBackendNotSnap.length) console.log('   MATCH');
  process.exit(inSnapNotBackend.length ? 1 : 0);
}

const outIdx = argv.indexOf('--out');
const json = JSON.stringify(manifest, null, 2) + '\n';
if (outIdx !== -1) {
  writeFileSync(argv[outIdx + 1], json);
  console.error(`wrote ${backed.length} route templates (${routes.length} method+path) to ${argv[outIdx + 1]}`);
} else {
  process.stdout.write(json);
}
