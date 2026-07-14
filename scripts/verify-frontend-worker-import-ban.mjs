#!/usr/bin/env node
// verify-frontend-worker-import-ban.mjs · Wave C0.1 (260713) · the repo-boundary gate for the
// x-backend extraction program (BACKEND_REPOSITORY_CUTOVER_PREFLIGHT.md).
//
// Two blocking assertions:
//   (1) IMPORT BAN — no file outside src/workers/** may import from a `workers/` path. The single
//       historical offender (src/shared/services/api-client/types.ts:47 re-exporting
//       src/workers/dal/types) was decoupled in C0.1; this gate keeps the boundary closed so the
//       backend tree stays extractable with zero reverse dependencies.
//   (2) CONTRACT-COPY BYTE-SYNC — src/shared/services/api-client/contract-types/{identity,auth,
//       event,project-source,xcp-identity-contracts}.ts are BYTE-IDENTICAL copies of their
//       src/workers/dal/types counterparts (identity.ts re-exports from xcp-identity-contracts,
//       so the closure is five files). While both trees exist in this repo, any edit to either side without the
//       mirror edit fails here (drift can never be silent). After the x-backend cutover removes
//       the workers tree from active duty, assertion (2) auto-degrades to PASS (source absent ⇒
//       the copies are the frozen contract by design).
//
// Exit 0 = boundary holds. Exit 1 = violation (each printed with file:line).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REPO, 'src');
const WORKERS_PREFIX = join(SRC, 'workers');

const failures = [];

// ── (1) import ban ─────────────────────────────────────────────────────────────────────────────
// Any import/export-from whose specifier contains a path segment `workers/` (relative or aliased),
// in a .ts/.tsx/.js/.jsx/.mjs file under src/ but outside src/workers/.
const IMPORT_RE = /(?:import|export)\s+[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      yield* walk(p);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry) && !/\.test\./.test(entry)) {
      yield p;
    }
  }
}

for (const file of walk(SRC)) {
  if (file.startsWith(WORKERS_PREFIX)) continue; // backend may import itself freely
  const src = readFileSync(file, 'utf-8');
  let m;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1] || m[2] || '';
    // ban any specifier that traverses into a workers/ tree (e.g. '../../../workers/dal/types')
    if (/(^|\/)workers\//.test(spec)) {
      const line = src.slice(0, m.index).split('\n').length;
      failures.push(`${relative(REPO, file)}:${line} imports '${spec}' — frontend→workers imports are banned (C0.1 boundary)`);
    }
  }
}

// ── (2) contract-copy byte-sync ────────────────────────────────────────────────────────────────
const PAIRS = ['identity.ts', 'auth.ts', 'event.ts', 'project-source.ts', 'xcp-identity-contracts.ts'].map((f) => ({
  source: join(SRC, 'workers/dal/types', f),
  copy: join(SRC, 'shared/services/api-client/contract-types', f),
  name: f,
}));

for (const { source, copy, name } of PAIRS) {
  if (!existsSync(copy)) {
    failures.push(`contract-types/${name} missing — the browser contract copy set is incomplete`);
    continue;
  }
  if (!existsSync(source)) continue; // post-cutover: workers tree gone ⇒ copies are the frozen contract
  const a = readFileSync(source, 'utf-8');
  const b = readFileSync(copy, 'utf-8');
  if (a !== b) {
    failures.push(
      `contract-types/${name} DIFFERS from src/workers/dal/types/${name} — edit both sides together (byte-sync contract, C0.1)`,
    );
  }
}

// ── verdict ───────────────────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error('✗ frontend-worker import-ban / contract-sync VIOLATIONS:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('☑ frontend-worker import ban holds · 0 reverse imports · contract-types byte-synced (5/5)');
