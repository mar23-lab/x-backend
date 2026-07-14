#!/usr/bin/env node
// verify-admissibility-enum-ssot.mjs · M6 admissibility-vocabulary drift gate (260707).
//
// P11 AI-context admissibility has ONE 4-state vocabulary (visible|excluded|candidate|approved). It lives
// in three places that must never drift apart, or the DB will accept a value the code rejects (or vice
// versa): the migration 049 CHECK constraint, the TS SSOT (src/workers/lib/admissibility.ts), and the
// grounding filter that binds to it. This gate parses the enum out of the migration CHECK and the TS
// constant and FAILS if the two sets differ. Prevention > detection.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = 'src/workers/db/migrations/049_documents_admissibility.sql';
const SSOT = 'src/workers/lib/admissibility.ts';

const fail = (msg) => { console.error(`✗ admissibility-enum-ssot · FAIL — ${msg}`); process.exit(1); };

function readOrFail(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) fail(`${rel} not found`);
  return fs.readFileSync(abs, 'utf8');
}

// 1) Values from the migration CHECK: admissibility IN ('a','b',...)
const mig = readOrFail(MIGRATION);
const checkMatch = mig.match(/admissibility\s+IN\s*\(([^)]*)\)/i);
if (!checkMatch) fail(`${MIGRATION} has no \`admissibility IN (...)\` CHECK`);
const migValues = new Set([...checkMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

// 2) Values from the TS SSOT: ADMISSIBILITY_VALUES = ['a','b',...] as const
const ssot = readOrFail(SSOT);
const arrMatch = ssot.match(/ADMISSIBILITY_VALUES\s*=\s*\[([^\]]*)\]/);
if (!arrMatch) fail(`${SSOT} has no ADMISSIBILITY_VALUES array`);
const tsValues = new Set([...arrMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

// 3) Compare as sets (order-independent).
const only = (a, b) => [...a].filter((x) => !b.has(x));
const migOnly = only(migValues, tsValues);
const tsOnly = only(tsValues, migValues);
if (migOnly.length || tsOnly.length) {
  fail(`enum drift — migration-only: [${migOnly.join(', ') || 'none'}] · ts-only: [${tsOnly.join(', ') || 'none'}]`);
}
if (migValues.size !== 4) fail(`expected 4 admissibility states, found ${migValues.size}: [${[...migValues].join(', ')}]`);

console.log(`☑ admissibility-enum-ssot · PASS · migration CHECK == TS SSOT == {${[...tsValues].sort().join(', ')}}`);
process.exit(0);
