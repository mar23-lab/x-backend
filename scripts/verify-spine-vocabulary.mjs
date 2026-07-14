#!/usr/bin/env node
// scripts/verify-spine-vocabulary.mjs · Migration-adoption wave (260711).
//
// THE REAL "T17" ANTI-DRIFT GATE. The frontend seat asked for a CI check that a UI
// spine-action gate table can never exceed the server's canActOnSpine vocabulary. The
// right shape (verified against source): the frontend must NOT re-declare an action
// table at all — it gates on the /session identity.spine_authority envelope at runtime
// (src/shared/platform/iam.ts). For BUILD-TIME checks (and for the prototype's migration
// overlay to map its ~22 spine-gated controls onto the real actions), we publish ONE
// machine-readable vocabulary: data/spine-authority-vocabulary.v1.json.
//
// This gate keeps that JSON honest. THREE teeth:
//   T1  the const SPINE_ACTIONS (spine-authority.ts) === the SpineAction union
//       (permissions.ts)  — catches the exact "17 actions"/"9 actions" stale-comment
//       class where the const and the type silently disagree.
//   T2  data/spine-authority-vocabulary.v1.json .actions === SPINE_ACTIONS, EXACT ORDER,
//       and .action_count === length — the JSON is a faithful projection, never a fork.
//   T3  .deny_reasons === the SpineDenyReason union; .allow_reason present; _meta.schema
//       is the declared id.
//
// Source of truth = the TypeScript. The JSON is generated-by-hand-then-checked; if they
// drift, THIS fails, not production. Dependency-free (regex over source), matching the
// repo's no-new-dep posture.
//
//   node scripts/verify-spine-vocabulary.mjs            # gate
//   node scripts/verify-spine-vocabulary.mjs --self-test # prove every tooth bites

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SPINE_AUTHORITY_TS = 'src/workers/lib/spine-authority.ts';
const PERMISSIONS_TS = 'src/workers/lib/permissions.ts';
const VOCAB_JSON = 'data/spine-authority-vocabulary.v1.json';
const SCHEMA_ID = 'xlooop.spine-authority-vocabulary.v1';

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** Quoted string members of `export const SPINE_ACTIONS ... = [ ... ] as const;` (array order preserved). */
function parseSpineActionsConst(src) {
  const m = src.match(/export const SPINE_ACTIONS[^=]*=\s*\[([\s\S]*?)\]\s*as const;/);
  if (!m) throw new Error(`could not locate SPINE_ACTIONS const in ${SPINE_AUTHORITY_TS}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

/** Members of `export type <Name> = | 'a' | 'b' ... ;` (declaration order). */
function parseUnion(src, typeName, file) {
  const re = new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?);`);
  const m = src.match(re);
  if (!m) throw new Error(`could not locate type ${typeName} in ${file}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

function setsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every(x => sb.has(x)) && new Set(a).size === a.length;
}

function orderedEqual(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function runChecks({ spineSrc, permSrc, vocab }) {
  const errors = [];
  const constActions = parseSpineActionsConst(spineSrc);
  const unionActions = parseUnion(permSrc, 'SpineAction', PERMISSIONS_TS);
  const unionReasons = parseUnion(permSrc, 'SpineDenyReason', PERMISSIONS_TS);

  // T1 — const vs type union (the stale-count class)
  if (!setsEqual(constActions, unionActions)) {
    const onlyConst = constActions.filter(a => !unionActions.includes(a));
    const onlyType = unionActions.filter(a => !constActions.includes(a));
    errors.push(`T1 const/type drift · SPINE_ACTIONS(${constActions.length}) vs SpineAction(${unionActions.length})` +
      (onlyConst.length ? ` · const-only: ${onlyConst.join(',')}` : '') +
      (onlyType.length ? ` · type-only: ${onlyType.join(',')}` : ''));
  }

  // T2 — JSON.actions faithful (exact order) + count
  if (!Array.isArray(vocab.actions) || !orderedEqual(vocab.actions, constActions)) {
    errors.push(`T2 ${VOCAB_JSON} .actions != SPINE_ACTIONS (exact order) · json(${(vocab.actions || []).length}) vs source(${constActions.length})`);
  }
  if (vocab.action_count !== constActions.length) {
    errors.push(`T2 .action_count ${vocab.action_count} != ${constActions.length}`);
  }

  // T3 — deny reasons + envelope metadata
  if (!Array.isArray(vocab.deny_reasons) || !setsEqual(vocab.deny_reasons, unionReasons)) {
    errors.push(`T3 .deny_reasons != SpineDenyReason · json(${(vocab.deny_reasons || []).length}) vs source(${unionReasons.length})`);
  }
  if (!vocab.allow_reason) errors.push('T3 .allow_reason missing (expected "active_entitlement")');
  if (!vocab._meta || vocab._meta.schema !== SCHEMA_ID) {
    errors.push(`T3 ._meta.schema != ${SCHEMA_ID}`);
  }

  return { errors, counts: { actions: constActions.length, reasons: unionReasons.length } };
}

function selfTest() {
  const spineSrc = read(SPINE_AUTHORITY_TS);
  const permSrc = read(PERMISSIONS_TS);
  const vocab = JSON.parse(read(VOCAB_JSON));
  let failures = 0;
  const expect = (name, cond) => { if (!cond) { failures++; console.log(`  ✗ self-test ${name}`); } else console.log(`  ☑ self-test ${name}`); };

  // baseline green
  expect('baseline-green', runChecks({ spineSrc, permSrc, vocab }).errors.length === 0);
  // T1 bites: drop one action from the const only
  const brokenConst = spineSrc.replace("'runtime:configure',", '');
  expect('T1-bites', runChecks({ spineSrc: brokenConst, permSrc, vocab }).errors.some(e => e.startsWith('T1')));
  // T2 bites: mutate JSON actions
  expect('T2-bites', runChecks({ spineSrc, permSrc, vocab: { ...vocab, actions: vocab.actions.slice(0, -1) } }).errors.some(e => e.startsWith('T2')));
  // T3 bites: drop a deny reason
  expect('T3-bites', runChecks({ spineSrc, permSrc, vocab: { ...vocab, deny_reasons: vocab.deny_reasons.slice(0, -1) } }).errors.some(e => e.startsWith('T3')));
  return failures;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  console.log('verify-spine-vocabulary · 260711');
  const selfTestOnly = process.argv.includes('--self-test');
  // Teeth always run (preamble) so the single ci-local entry enforces both mechanism + state.
  const selfTestFailures = selfTest();
  if (selfTestFailures > 0) {
    console.log(`\n✗ self-test ${selfTestFailures} FAILED — gate mechanism broken`);
    process.exit(1);
  }
  if (selfTestOnly) {
    console.log('\n☑ self-test all teeth bite');
    process.exit(0);
  }
  let result;
  try {
    result = runChecks({ spineSrc: read(SPINE_AUTHORITY_TS), permSrc: read(PERMISSIONS_TS), vocab: JSON.parse(read(VOCAB_JSON)) });
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    process.exit(1);
  }
  for (const e of result.errors) console.log(`  ✗ ${e}`);
  if (result.errors.length === 0) {
    console.log(`  ☑ ${result.counts.actions} spine actions · ${result.counts.reasons} deny reasons · const==type==json`);
  }
  console.log(`\n${result.errors.length === 0 ? '☑' : '✗'} spine vocabulary ${result.errors.length === 0 ? 'in sync (source ⇒ json)' : `DRIFT · ${result.errors.length} error(s)`}`);
  process.exit(result.errors.length === 0 ? 0 : 1);
}
