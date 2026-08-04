#!/usr/bin/env node
/**
 * verify-error-code-preservation
 *
 * A route handler must pass the CAUGHT error to errorEnvelope, not a hand-built wrapper.
 *
 * WHY THIS GATE EXISTS — it was written after a real production defect that this exact pattern hid.
 *
 * `errorEnvelope` deliberately PRESERVES a thrown error's `code` on the wire (middleware/error.ts,
 * "EE-1"), because silently rewriting an unregistered code to INTERNAL_ERROR had already masked
 * ~30 real codes once. That guarantee is worth nothing if the handler throws the original error
 * away first:
 *
 *     catch (err) {
 *       return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: err.message });
 *     }
 *
 * That wrapper destroys the cause before the envelope can preserve it — on the wire AND in the
 * Sentry capture, since `captureException` then receives the wrapper instead of the real error.
 *
 * MEASURED COST, 2026-08-04. `POST /api/v1/documents` was returning 500 in production and had, in
 * fact, NEVER once succeeded — zero `operation_events` and zero `projection_outbox` rows for
 * document uploads, ever. Diagnosing it burned a long sequence of probes because the response said
 * only `{"code":"INTERNAL_ERROR"}`.
 *
 * The contrast is the whole argument: `POST /api/v1/intake/:id/execute` failed the same week and
 * its handler passes the raw error through, so the wire carried `{"code":"42501"}` — which named
 * the failing LAYER immediately and led to the fix. Same class of bug, same day; one route was
 * diagnosable and the other was not, and the only difference was this line.
 *
 * The correct idiom already dominates the codebase 196 to 13. This gate pins that.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanRoot = join(root, 'src/workers');
const selfTest = process.argv.includes('--self-test');

// A hand-built literal passed where the caught error belongs.
const OFFENDING = /errorEnvelope\(\s*ctx\s*,\s*\{[^}]*\bcode\s*:\s*'INTERNAL_ERROR'/;

export function findOffences(source) {
  const offences = [];
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    if (OFFENDING.test(line)) offences.push({ line: index + 1, text: line.trim() });
  });
  return offences;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function runSelfTest() {
  const controls = [
    [
      findOffences(`return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });`).length,
      1,
      'the hand-built INTERNAL_ERROR wrapper is DETECTED',
    ],
    [findOffences('return errorEnvelope(ctx, err);').length, 0, 'the correct idiom passes'],
    [findOffences('return errorEnvelope(ctx, makeError(\'NOT_FOUND\', \'missing\', 404));').length, 0, 'a coded makeError passes'],
    [
      findOffences(`return errorEnvelope(ctx, { status: 400, code: 'BAD_FORM', message: 'nope' });`).length,
      0,
      'a deliberate 4xx literal with a REAL code is allowed — it carries information rather than erasing it',
    ],
    [findOffences('// errorEnvelope(ctx, { code: \'INTERNAL_ERROR\' }) in a comment').length, 1, 'comment form is detected (conservative: prefer a false positive to a silent miss)'],
  ];
  // The count below is MEASURED from the results, never `controls.length/controls.length`. The
  // estate's hollow-success scan caught exactly that shape in the first draft of this file — a
  // self-referential ratio "cannot disagree with itself", which is the defect class this whole gate
  // family exists to remove. Reproducing it inside a gate written to enforce honesty is the reason
  // the meta-gate is worth having.
  const passed = controls.filter(([actual, expected]) => actual === expected).length;
  const failed = controls.filter(([actual, expected]) => actual !== expected);
  for (const [actual, expected, label] of controls) {
    console.log(`  ${actual === expected ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (failed.length) {
    console.error(
      `verify-error-code-preservation self-test FAIL — ${passed} of ${controls.length} detector controls held: `
      + failed.map((row) => row[2]).join('; ')
    );
    process.exit(1);
  }
  console.log(`verify-error-code-preservation self-test PASS — ${passed} of ${controls.length} detector controls held`);
  process.exit(0);
}

if (selfTest) runSelfTest();

const files = walk(scanRoot);
let offenceCount = 0;
let assertions = 0;
for (const file of files) {
  assertions += 1;
  const offences = findOffences(readFileSync(file, 'utf8'));
  for (const offence of offences) {
    offenceCount += 1;
    console.error(`  ${relative(root, file)}:${offence.line}  ${offence.text}`);
  }
}

if (offenceCount > 0) {
  console.error(
    `\nverify-error-code-preservation FAIL — ${offenceCount} handler(s) discard the caught error and hand-build\n`
    + `an INTERNAL_ERROR wrapper, so errorEnvelope cannot preserve the real code (and Sentry captures the\n`
    + `wrapper, not the cause). Pass the error through instead:\n\n`
    + `    catch (err) { return errorEnvelope(ctx, err); }\n\n`
    + `errorEnvelope already resolves the status (explicit e.status -> CODE_TO_STATUS -> 500) and already\n`
    + `scrubs the message on the wire for 5xx, so nothing leaks by passing the cause through.\n`
  );
  process.exit(1);
}

console.log(`verify-error-code-preservation PASS — ${assertions} route source file(s) asserted, 0 code-destroying handlers`);
