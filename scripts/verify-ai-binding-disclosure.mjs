#!/usr/bin/env node
/**
 * verify-ai-binding-disclosure
 *
 * A code path that substitutes a DETERMINISTIC/CANNED result because the AI binding is absent must
 * SAY SO. Every `if (!ai)`-shaped guard that returns must be accompanied by a structured log.
 *
 * WHY THIS GATE EXISTS — an operator reported the bug, and the fix was applied to ONE of five sites.
 *
 * The operator's words: two different chat questions came back byte-identical and unhelpful. The
 * cause was partly that `answerCockpitChat` returned its canned floor whenever the AI binding was
 * missing, logging nothing — so on the wire and in the logs it was indistinguishable from a model
 * that ran and chose those words. `cockpit-chat.ts` now logs `cockpit_chat_no_ai_binding`, and its
 * comment says: "Silence is the worst possible reading of 'the AI never ran': make it say so."
 *
 * That fix was applied to that one function. A 639-site sweep of src/workers/ on 2026-08-05 found
 * FOUR structural twins still silent:
 *
 *   agent-digest.ts       the weekly workspace digest      -> canned template
 *   agent-digest.ts       the day-1 onboarding welcome     -> canned template
 *   prompt-refine.ts      "Improve wording"                -> returns your own text unchanged
 *   packet-enrichment.ts  intent enrichment                -> deterministic floor, NO observer
 *
 * The enrichment one is the worst: the other degrades at least write a model_execution receipt via
 * the observer, but a missing binding starts no observer, so that path left no trace anywhere.
 *
 * WHY A COUNT-THE-SITES FIX CANNOT HOLD. The fifth twin is written by whoever adds the next
 * AI-backed surface. The measured ratio at the time this gate was written was 9 instrumented of 54
 * degraded-substitution sites — 17%. This gate does not try to enforce all 54; it enforces the ONE
 * shape that is mechanically recognisable and that has already burned a customer: the AI-binding
 * guard. Attempting the general case would produce a red nobody can clear, which this estate
 * refuses twice over.
 *
 * RECEIPTS ARE NOT LOGS, and the distinction is deliberate: an `execution.complete({status:
 * 'fallback'})` row is DB-side and invisible to `wrangler tail`, and the observer is an optional
 * parameter so it is undefined wherever a caller omits it. This gate requires a console log.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanRoot = join(root, 'src/workers');
const selfTest = process.argv.includes('--self-test');

/**
 * Find `if (!<something>.ai)` / `if (!ai)` guards whose body returns, and report the ones with no
 * console log between the guard and its return.
 *
 * Deliberately narrow: only the AI-binding shape, only when the guard RETURNS (a guard that throws
 * is already loud, and one that falls through is not a substitution).
 */
export function findSilentGuards(source) {
  const offences = [];
  const lines = source.split('\n');
  const guard = /if\s*\(\s*!\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?ai\s*\)/;

  lines.forEach((line, index) => {
    if (!guard.test(line)) return;
    // Comment lines describing the shape are not code.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;

    // Single-line form: `if (!ai) return X;`
    if (/\breturn\b/.test(line)) {
      if (!/console\.(log|warn|error)/.test(line)) offences.push({ line: index + 1, form: 'single-line' });
      return;
    }
    // Block form: scan to the matching close brace, bounded.
    let depth = 0;
    let started = false;
    let hasLog = false;
    let hasReturn = false;
    for (let i = index; i < Math.min(lines.length, index + 25); i += 1) {
      const text = lines[i];
      for (const ch of text) {
        if (ch === '{') { depth += 1; started = true; } else if (ch === '}') depth -= 1;
      }
      if (started && i > index) {
        if (/console\.(log|warn|error)/.test(text)) hasLog = true;
        if (/\breturn\b/.test(text)) hasReturn = true;
      }
      if (started && depth <= 0) break;
    }
    if (hasReturn && !hasLog) offences.push({ line: index + 1, form: 'block' });
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
    [findSilentGuards('if (!ai) return deterministic;').length, 1,
      'a SILENT single-line AI-binding guard is DETECTED (the shipped defect)'],
    [findSilentGuards("if (!ai) { console.log('x'); return deterministic; }").length, 0,
      'the same guard passes once it logs'],
    [findSilentGuards('if (!opts.ai) return deterministic;').length, 1,
      'the member-access form (!opts.ai) is DETECTED'],
    [findSilentGuards("if (!ai) {\n  console.log(JSON.stringify({kind:'x'}));\n  return d;\n}").length, 0,
      'a multi-line guard that logs before returning passes'],
    [findSilentGuards('if (!ai) {\n  return d;\n}').length, 1,
      'a multi-line guard with no log is DETECTED'],
    [findSilentGuards('// if (!ai) return deterministic;').length, 0,
      'a commented-out guard is not code'],
    [findSilentGuards('if (!ai) {\n  throw new Error("no binding");\n}').length, 0,
      'a guard that THROWS is already loud and is not a substitution'],
    [findSilentGuards('if (!available) return x;').length, 0,
      'an unrelated guard is not matched — the scanner stays narrow'],
  ];
  let passed = 0;
  for (const [actual, expected, label] of controls) {
    const ok = actual === expected;
    if (ok) passed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (passed !== controls.length) {
    console.error(`verify-ai-binding-disclosure self-test FAIL — ${passed} of ${controls.length} controls held`);
    process.exit(1);
  }
  console.log(`verify-ai-binding-disclosure self-test PASS — ${passed} of ${controls.length} controls held`);
  process.exit(0);
}

if (selfTest) runSelfTest();

const files = walk(scanRoot);
let offences = 0;
let guardsSeen = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const found = findSilentGuards(source);
  guardsSeen += (source.match(/if\s*\(\s*!\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?ai\s*\)/g) || []).length;
  for (const o of found) {
    offences += 1;
    console.error(`  ${relative(root, file)}:${o.line}  AI-binding guard returns a substitute with NO log (${o.form})`);
  }
}

if (offences > 0) {
  console.error(
    `\nverify-ai-binding-disclosure FAIL — ${offences} AI-binding guard(s) substitute a canned result silently.\n`
    + `An operator reported this exact symptom: two different questions answered byte-identically, with\n`
    + `no signal to point at. Emit a structured log naming what was requested and what was served, e.g.\n`
    + `  console.log(JSON.stringify({ kind: '<surface>_no_ai_binding', ... }));\n`
    + `An execution receipt is NOT sufficient: it is DB-side, invisible to wrangler tail, and absent\n`
    + `entirely when no observer was started.\n`,
  );
  process.exit(1);
}

console.log(
  `verify-ai-binding-disclosure PASS — ${files.length} source file(s) scanned, `
  + `${guardsSeen} AI-binding guard(s) found, 0 silent`,
);
