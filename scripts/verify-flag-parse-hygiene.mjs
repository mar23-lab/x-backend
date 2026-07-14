#!/usr/bin/env node
// scripts/verify-flag-parse-hygiene.mjs · J-W0 (260711-I / FGH-1/2) — the structural fix for the
// quote-intolerant flag-parse class.
//
// ROOT CAUSE (Part O.4 readiness-gate failure, re-surfaced by the J-wave audit as FGH-1): a flag
// read as `String(env.X_ENABLED || '') === 'true'` (or `!== 'true'`, or `.toLowerCase() === 'true'`)
// silently fails to engage when the value is entered via the Cloudflare dashboard / `wrangler secret
// put` as the quoted string `"true"` — the exact entry path for an un-declared flag. For a
// security-relevant flag whose OFF direction is the LESS-safe one (e.g. SOURCE_SCOPE_ENFORCEMENT),
// that is a fail-toward-less-safe defect. `src/workers/lib/env-flag.ts::envFlagTrue` strips quotes +
// whitespace and lower-cases before comparing; it is the ONLY sanctioned flag reader.
//
// THE RULE: no `*_ENABLED` env flag may be compared with a bare `=== 'true'` / `!== 'true'` /
// `.toLowerCase() === 'true'`. Route every flag read through envFlagTrue(...). env-flag.ts itself and
// test files are exempt (the reader's own definition + tests that assert the tolerant behavior).
//
//   node scripts/verify-flag-parse-hygiene.mjs             # gate
//   node scripts/verify-flag-parse-hygiene.mjs --self-test  # prove the teeth bite

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SCAN_ROOT = 'src/workers';
const READER = 'src/workers/lib/env-flag.ts';

// A line offends if it reads a *_ENABLED flag with a strict/lowercase comparison to 'true'.
// Comments are allowed to describe the historical form; we only flag executable code, so lines whose
// first non-space chars are `//` or `*` are skipped.
const OFFENDER = /_ENABLED\b[\s\S]*?(===|!==)\s*'true'|_ENABLED\b[\s\S]*?\.toLowerCase\(\)\s*===\s*'true'/;

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function tsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(path.relative(repoRoot, p));
    }
  };
  walk(path.join(repoRoot, dir));
  return out.sort();
}

export function scanLine(line) {
  if (isCommentLine(line)) return false;
  return OFFENDER.test(line);
}

export function runChecks({ files, read }) {
  const offenders = [];
  for (const f of files) {
    if (f === READER || f.includes('__tests__')) continue;
    const src = read(f);
    src.split('\n').forEach((line, i) => {
      if (scanLine(line)) offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  return offenders;
}

function loadInputs() {
  return {
    files: tsFiles(SCAN_ROOT),
    read: (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8'),
  };
}

function selfTest() {
  let failures = 0;
  const expect = (name, cond) => { if (!cond) { failures++; console.log(`  ✗ self-test ${name}`); } else console.log(`  ☑ self-test ${name}`); };
  // real tree is clean
  expect('tree-clean', runChecks(loadInputs()).length === 0);
  // a strict === 'true' bites
  expect('strict-eq-bites', scanLine(`  if (String(ctx.env.FOO_ENABLED || '') === 'true') {`) === true);
  // a !== 'true' bites
  expect('strict-neq-bites', scanLine(`  if (ctx.env.BAR_ENABLED !== 'true') return;`) === true);
  // a lowercase === 'true' bites
  expect('lowercase-bites', scanLine(`  const on = String(env.BAZ_ENABLED || '').toLowerCase() === 'true';`) === true);
  // envFlagTrue does NOT bite
  expect('tolerant-clean', scanLine(`  if (envFlagTrue(ctx.env.FOO_ENABLED)) {`) === false);
  // a comment describing the old form does NOT bite
  expect('comment-clean', scanLine(`  // true only when FOO_ENABLED === 'true' (route-read)`) === false);
  console.log(failures === 0 ? '\n☑ self-test all teeth bite' : `\n✗ ${failures} self-test failure(s)`);
  return failures === 0 ? 0 : 1;
}

function main() {
  console.log("verify-flag-parse-hygiene · J-W0 (FGH-1/2)");
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  const offenders = runChecks(loadInputs());
  if (offenders.length > 0) {
    console.log(`\n✗ ${offenders.length} flag read(s) use a quote-intolerant strict/lowercase comparison — route through envFlagTrue (src/workers/lib/env-flag.ts):`);
    for (const o of offenders) console.log(`  ${o}`);
    process.exit(1);
  }
  console.log('  ☑ all *_ENABLED flag reads route through envFlagTrue (quote-tolerant)');
  console.log('\n☑ flag-parse-hygiene holds');
  process.exit(0);
}

main();
