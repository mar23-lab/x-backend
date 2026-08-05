#!/usr/bin/env node
/**
 * verify-rls-connection-single-source
 *
 * ONE module decides which connection a tenant-scoped read runs on: `src/workers/db/rls-connection.ts`.
 * Nothing else may branch on `XLOOOP_RLS_APP_DATABASE_URL`.
 *
 * WHY THIS GATE EXISTS — the fix it protects was applied to an ENUMERATED LIST and missed a member.
 *
 * `rls-connection.ts` was written to delete a fail-OPEN expression that six call sites had each
 * written independently:
 *
 *     neonClient(env.XLOOOP_RLS_APP_DATABASE_URL || env.DATABASE_URL)
 *     env.XLOOOP_RLS_APP_DATABASE_URL ? neonClient(env.XLOOOP_RLS_APP_DATABASE_URL) : sql
 *
 * Its header names those six: index.ts:172/384/465, documents.ts:114/173, mcp-customer-reads.ts:141.
 * All six were migrated. `routes/workspaces.ts` held a SEVENTH that the header never counted, and it
 * survived the entire migration — still constructing its own connection, still failing open, and
 * feeding the result into the model's document-grounding context. It was found on 2026-08-05 by
 * scanning for the shape rather than trusting the list.
 *
 * WHY THAT MATTERS MORE THAN AN ORDINARY FALLBACK. `neondb_owner` — the role behind `DATABASE_URL` —
 * carries BYPASSRLS, and `relforcerowsecurity` is 0 of 96 tables, so every policy on all 73
 * RLS-enabled tables is inert on that connection. The difference between "the secret is bound" and
 * "the secret is missing" is the difference between full tenant isolation and none, decided silently
 * at runtime. `resolveRlsSql` throws 503 under production authority precisely so that decision is
 * loud; a site that bypasses it opts out of the only control.
 *
 * WHY A COUNT-THE-SITES FIX CANNOT HOLD. The next such site is written by someone who never reads
 * this module. An enumeration is a snapshot; this gate is the invariant.
 *
 * THE RULE. Outside `db/rls-connection.ts`, the identifier may appear only in:
 *   - a TYPE declaration  (`XLOOOP_RLS_APP_DATABASE_URL?: string;`) — env-shape plumbing, decides nothing
 *   - a COMMENT           — including this file's own prose and the module's header
 * Any other appearance is an expression that decides behaviour, and is an offence.
 *
 * COMMENT STRIPPING IS LOAD-BEARING, not incidental: the module being protected documents the exact
 * expression it forbids, and so does the fixed call site. A scanner that skipped this step would
 * flag its own documentation and be deleted as noise — which is how honest gates die.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanRoot = join(root, 'src/workers');
const selfTest = process.argv.includes('--self-test');

const SECRET = 'XLOOOP_RLS_APP_DATABASE_URL';
// The single module allowed to branch on the secret.
const OWNER_MODULE = 'src/workers/db/rls-connection.ts';

/**
 * Replace comment bodies with spaces, preserving line structure and offsets so reported line
 * numbers stay true. String literals are preserved: a secret name inside a string is still code.
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1; }
    } else if (two === '/*') {
      while (i < n && source.slice(i, i + 2) !== '*/') { out += source[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  '; i += 2;
    } else {
      out += source[i]; i += 1;
    }
  }
  return out;
}

/** A type declaration decides nothing: `XLOOOP_RLS_APP_DATABASE_URL?: string;` */
function isTypeDeclaration(line) {
  return new RegExp(`${SECRET}\\s*\\??\\s*:\\s*(string|\\w+)\\s*;?\\s*$`).test(line.trim());
}

export function findOffences(source) {
  const offences = [];
  const lines = stripComments(source).split('\n');
  lines.forEach((line, index) => {
    if (!line.includes(SECRET)) return;
    if (isTypeDeclaration(line)) return;
    offences.push({ line: index + 1, text: line.trim() });
  });
  return offences;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function runSelfTest() {
  const controls = [
    [findOffences(`const s = neonClient(env.${SECRET} || env.DATABASE_URL);`).length, 1,
      'the exact fail-open OR expression is DETECTED'],
    [findOffences(`const s = env.${SECRET} ? neonClient(env.${SECRET}) : sql;`).length, 1,
      'the ternary fail-open form is DETECTED'],
    [findOffences(`  ${SECRET}?: string;`).length, 0,
      'a type declaration is NOT an offence'],
    [findOffences(`  ${SECRET}: string;`).length, 0,
      'a non-optional type declaration is NOT an offence'],
    [findOffences(`// neonClient(env.${SECRET} || env.DATABASE_URL)`).length, 0,
      'the module doc comment describing the forbidden shape is NOT an offence'],
    [findOffences(`/*\n * ${SECRET} || DATABASE_URL was the old shape\n */`).length, 0,
      'a block comment describing it is NOT an offence'],
    [findOffences(`const mode = env.${SECRET} ? 'app' : 'owner';`).length, 1,
      're-deriving the binding label inline is DETECTED (the /health duplicate)'],
    [findOffences('const s = resolveRlsSql(ctx.env, neonClient(ctx.env.DATABASE_URL));').length, 0,
      'the correct call through resolveRlsSql passes'],
    [findOffences(`const a = 1; // ${SECRET}\nconst b = env.${SECRET} || x;`)[0]?.line, 2,
      'the reported line number survives comment stripping'],
  ];
  let passed = 0;
  for (const [actual, expected, label] of controls) {
    const ok = actual === expected;
    if (ok) passed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (passed !== controls.length) {
    console.error(`verify-rls-connection-single-source self-test FAIL — ${passed} of ${controls.length} detector controls held`);
    process.exit(1);
  }
  console.log(`verify-rls-connection-single-source self-test PASS — ${passed} of ${controls.length} detector controls held`);
  process.exit(0);
}

if (selfTest) runSelfTest();

const files = walk(scanRoot);
let offences = 0;
let asserted = 0;
for (const file of files) {
  const rel = relative(root, file);
  if (rel === OWNER_MODULE) continue;
  asserted += 1;
  for (const o of findOffences(readFileSync(file, 'utf8'))) {
    offences += 1;
    console.error(`  ${rel}:${o.line}  ${o.text}`);
  }
}

if (offences > 0) {
  console.error(
    `\nverify-rls-connection-single-source FAIL — ${offences} site(s) outside ${OWNER_MODULE} branch on ${SECRET}.\n`
    + `Tenant reads must resolve their connection through resolveRlsSql(env, ownerSql), which throws 503\n`
    + `under production authority instead of silently continuing on the BYPASSRLS owner connection.\n`
    + `For the /health posture label, call rlsBindingMode(env) rather than re-deriving it.\n`,
  );
  process.exit(1);
}

console.log(
  `verify-rls-connection-single-source PASS — ${asserted} source file(s) asserted, `
  + `0 sites outside ${OWNER_MODULE} branch on ${SECRET}`,
);
