#!/usr/bin/env node
// verify-allowed-actions-server-derived.mjs · M4 authority-projection gate (260707).
//
// Cross-cutting invariant #1 (ACCESS_CONTROL_MATRIX.md): AUTHORITY IS SERVER-DERIVED, NEVER
// CLIENT-COMPUTED. This gate freezes the mechanism that guarantees it:
//   TOOTH 1 — no route may hand-roll authority. A literal `allowed_actions:` key in a route file means a
//     route computed its own action list (drift risk, the GAP-004 class). The ONLY sanctioned source is
//     src/workers/lib/allowed-actions.ts via withAuthority(), which spreads the key in at runtime — so the
//     literal string never appears in a route. Any literal occurrence in src/workers/routes = FAIL.
//   TOOTH 2 — purity. allowed-actions.ts must stay pure (no ctx / no DB / no I/O) so it is unit-testable
//     and cannot leak tenant data: it may not reference neonClient, ctx.get, or import a DAL adapter.
//   TOOTH 3 — coverage. The M4-adopted surfaces import + use withAuthority a minimum number of times, so
//     removing a projection (regressing a resource to no server-derived authority) fails here.
//
// Matrix correctness itself is the adversarial vitest proof in __tests__/allowed-actions.test.ts
// (wired blocking via verify:ip-boundary-suite). Prevention > detection.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_DIR = 'src/workers/routes';
const MODULE = 'src/workers/lib/allowed-actions.ts';

const violations = [];

// TOOTH 1 — no hand-rolled `allowed_actions:` literal anywhere in the route surface.
for (const entry of fs.readdirSync(path.join(ROOT, ROUTES_DIR), { withFileTypes: true })) {
  if (!entry.isFile() || !/\.ts$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
  const rel = path.join(ROUTES_DIR, entry.name);
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const m = src.match(/\ballowed_actions\s*:/);
  if (m) {
    const line = src.slice(0, m.index).split('\n').length;
    violations.push({ rel, line, kind: 'hand-rolled' });
  }
}

// TOOTH 2 — the authority module stays pure.
const modAbs = path.join(ROOT, MODULE);
if (!fs.existsSync(modAbs)) {
  violations.push({ rel: MODULE, line: 0, kind: 'module-missing' });
} else {
  const mod = fs.readFileSync(modAbs, 'utf8');
  for (const banned of ['neonClient', 'ctx.get', 'DalAdapter']) {
    if (mod.includes(banned)) violations.push({ rel: MODULE, line: 0, kind: 'impure', token: banned });
  }
}

// TOOTH 3 — coverage: M4-adopted surfaces import + use withAuthority.
const MANIFEST = [
  { file: 'projects.ts', min: 4 },          // list + single-read + project_source(empty) + project_source(list)
  { file: 'events.ts', min: 2 },            // operator overlay + main list
  { file: 'sources.ts', min: 1 },           // user source list
  // A-W2c (260707) · widget-migration coverage extension
  { file: 'workspaces.ts', min: 4 },        // workspaces list + activity-summary + plan + :id/projects
  { file: 'synthetic-domains.ts', min: 2 }, // domain list + single
  { file: 'members.ts', min: 1 },           // member roster
];
for (const { file, min } of MANIFEST) {
  const rel = path.join(ROUTES_DIR, file);
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { violations.push({ rel, line: 0, kind: 'missing-file' }); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  if (!/from '\.\.\/lib\/allowed-actions'/.test(src)) violations.push({ rel, line: 0, kind: 'no-import' });
  const count = (src.match(/withAuthority\(/g) || []).length;
  if (count < min) violations.push({ rel, line: 0, kind: 'under-count', have: count, want: min });
}

if (violations.length) {
  console.error('✗ allowed-actions-server-derived · FAIL:');
  for (const v of violations) {
    if (v.kind === 'hand-rolled') {
      console.error(`    ${v.rel}:${v.line} · literal \`allowed_actions:\` — authority must come from withAuthority(), never hand-rolled`);
    } else if (v.kind === 'impure') {
      console.error(`    ${v.rel} · authority module references \`${v.token}\` — it must stay pure (no ctx/DB/I/O)`);
    } else if (v.kind === 'module-missing') {
      console.error(`    ${v.rel} · authority module not found`);
    } else if (v.kind === 'no-import') {
      console.error(`    ${v.rel} · missing \`import { withAuthority } from '../lib/allowed-actions'\``);
    } else if (v.kind === 'under-count') {
      console.error(`    ${v.rel} · withAuthority() used ${v.have}× but ${v.want} surface(s) require it`);
    } else if (v.kind === 'missing-file') {
      console.error(`    ${v.rel} · manifest file not found`);
    }
  }
  console.error('  See docs/security/ACCESS_CONTROL_MATRIX.md · invariant #1 (authority is server-derived).');
  process.exit(1);
}

console.log(`☑ allowed-actions-server-derived · PASS · pure authority module · ${MANIFEST.length} projected surfaces · 0 hand-rolled lists`);
process.exit(0);
