#!/usr/bin/env node
// verify-data-class-declared.mjs · M3 data-class response-envelope regression gate (260707).
//
// WHY: every tenant-facing list/read response must DECLARE its data_class (live | starter | template |
// redacted | public_safe) so a consumer — the current cockpit AND the future UI — can never mislabel
// starter/template/boilerplate content as the customer's LIVE records. Vocabulary SSOT:
// docs/security/DATA_CLASSIFICATION.md. Adoption helper: src/workers/lib/response-envelope.ts.
//
// THE RULE (two independent teeth):
//   TOOTH 1 — forbidden bare-key scan (auto-covering): a tenant-data payload return whose object literal
//     leads with a known envelope key (board_cards, projects, sources, documents, snapshots, templates)
//     MUST be wrapped in withDataClass(...). A wrapped return reads `ctx.json(withDataClass({ <key>` so it
//     does NOT match the bare `ctx.json({ <key>` pattern. Any bare match = an undeclared payload = FAIL.
//     This tooth auto-covers NEW routes that reuse these envelope keys — no manifest edit required.
//   TOOTH 2 — positive manifest coverage: the surfaces that return a VARIABLE (not an object literal — e.g.
//     events.ts returns `page`) can't be caught by tooth 1, so each is pinned here with a minimum
//     withDataClass() count. Removing a wrap on these drops the count → FAIL.
//
// Prevention > detection (session doctrine): lesson-to-gate for the response-truth-envelope class (P5).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_DIR = 'src/workers/routes';

// Envelope keys that ALWAYS denote a tenant-data payload. When one leads a `ctx.json({ <key>` object
// literal it must carry a data_class. (Error envelopes lead with `error`/`code`; single-item creates use
// `document`/`source`/`project`/`approval` singular keys — both intentionally excluded.)
const TENANT_DATA_KEYS = ['board_cards', 'projects', 'sources', 'documents', 'snapshots', 'templates'];
// `ctx.json({ projects` (optionally across a newline) — but NOT `ctx.json(withDataClass({ projects`.
const BARE_RE = new RegExp(
  String.raw`ctx\.json\(\s*\{\s*(` + TENANT_DATA_KEYS.join('|') + String.raw`)\b`,
  'g',
);

// Var-return surfaces (tooth 1 blind): file → minimum withDataClass() occurrences that MUST remain.
const MANIFEST = [
  { file: 'events.ts', min: 2 },                     // operator-overlay page + main page (both `page` vars)
  { file: 'board-cards.ts', min: 1 },
  { file: 'projects.ts', min: 3 },                   // list + sources(empty) + sources + children
  { file: 'documents.ts', min: 2 },                  // empty + list
  { file: 'sources.ts', min: 1 },
  { file: 'customer-workspace-feed.ts', min: 1 },    // 'starter'
  { file: 'template-policy-registry.ts', min: 2 },   // 'template' × 2 (effective-templates + snapshots)
  { file: 'synthetic-domains.ts', min: 1 },          // domain-members project list
  { file: 'workspaces.ts', min: 1 },                 // operator workspace project list
];

const violations = [];

// TOOTH 1 — no bare tenant-data payload returns anywhere in the route surface.
for (const entry of fs.readdirSync(path.join(ROOT, ROUTES_DIR), { withFileTypes: true })) {
  if (!entry.isFile() || !/\.ts$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
  const rel = path.join(ROUTES_DIR, entry.name);
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const m of src.matchAll(BARE_RE)) {
    const line = src.slice(0, m.index).split('\n').length;
    violations.push({ rel, line, kind: 'bare', key: m[1] });
  }
}

// TOOTH 2 — manifest surfaces keep their declared-count of withDataClass wraps + the import.
for (const { file, min } of MANIFEST) {
  const rel = path.join(ROUTES_DIR, file);
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { violations.push({ rel, line: 0, kind: 'missing-file' }); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  if (!/from '\.\.\/lib\/response-envelope'/.test(src)) {
    violations.push({ rel, line: 0, kind: 'no-import' });
  }
  const count = (src.match(/withDataClass\(/g) || []).length;
  if (count < min) violations.push({ rel, line: 0, kind: 'under-count', have: count, want: min });
}

if (violations.length) {
  console.error('✗ data-class-declared · FAIL — tenant response(s) do not declare data_class:');
  for (const v of violations) {
    if (v.kind === 'bare') {
      console.error(`    ${v.rel}:${v.line} · bare \`ctx.json({ ${v.key} … })\` — wrap in withDataClass({ … }, '<class>')`);
    } else if (v.kind === 'no-import') {
      console.error(`    ${v.rel} · missing \`import { withDataClass } from '../lib/response-envelope'\``);
    } else if (v.kind === 'under-count') {
      console.error(`    ${v.rel} · withDataClass() used ${v.have}× but ${v.want} tenant surface(s) require it`);
    } else if (v.kind === 'missing-file') {
      console.error(`    ${v.rel} · manifest file not found`);
    }
  }
  console.error('  Every tenant list/read must declare its data_class — see docs/security/DATA_CLASSIFICATION.md.');
  process.exit(1);
}

console.log(`☑ data-class-declared · PASS · ${MANIFEST.length} pinned surfaces · 0 bare tenant-data returns`);
process.exit(0);
