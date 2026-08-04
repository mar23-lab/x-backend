#!/usr/bin/env node
/**
 * verify-untyped-jsonb-params
 *
 * A bare tagged-template parameter inside a variadic-"any" SQL function is a GUARANTEED runtime
 * failure. PostgreSQL cannot infer the parameter's type and raises 42P18 `indeterminate_datatype`
 * — "could not determine data type of parameter $N" — on EVERY call.
 *
 *     jsonb_build_object('request_id', ${authority.request_id})        -- 42P18, always
 *     jsonb_build_object('request_id', ${authority.request_id}::text)  -- fine
 *
 * WHY THIS GATE EXISTS — a real production defect of exactly this shape.
 *
 * `POST /api/v1/documents` returned 500 on every call and had NEVER once succeeded in production:
 * one `documents` row in the entire table (2026-07-03), ZERO `operation_events` with
 * `source_tool='document_upload'`, ZERO `projection_outbox` rows for `document.uploaded`. The cause
 * was a single bare parameter in `dal/document-store.ts`, inside the `audit_written` CTE's
 * `jsonb_build_object`.
 *
 * WHY IT SURVIVED EVERYTHING ELSE — this is the part worth keeping:
 *
 *   - Unit suites drive a MOCK `sql` tag that never parses SQL, so no test could observe it.
 *   - Typecheck cannot see it: every TypeScript type involved is correct.
 *   - Replaying the statement against real PostgreSQL did NOT reproduce it, because the replay
 *     substituted literals inline — so there were no parameters at all. **An inline-literal replay
 *     is not the same statement.** The defect exists only in the parameterized form.
 *   - The route hand-built an INTERNAL_ERROR envelope, so 42P18 never reached the wire. One probe
 *     after that was fixed named it immediately (see verify-error-code-preservation).
 *
 * Minimal control, run against real PostgreSQL:
 *     SELECT jsonb_build_object('k', $1)         -> 42P18
 *     SELECT jsonb_build_object('k', $1::text)   -> {"k":"..."}
 *
 * The scanner is deliberately narrow: only variadic-"any" functions, only bare interpolations.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scanRoot = join(root, 'src/workers');
const selfTest = process.argv.includes('--self-test');

// PostgreSQL cannot infer a bare parameter's type inside these.
const VARIADIC_ANY = [
  'jsonb_build_object',
  'json_build_object',
  'jsonb_build_array',
  'json_build_array',
  'concat_ws',
];

function variadicRanges(source) {
  const ranges = [];
  for (const fn of VARIADIC_ANY) {
    let from = 0;
    for (;;) {
      const at = source.indexOf(`${fn}(`, from);
      if (at === -1) break;
      let depth = 0;
      let end = -1;
      for (let i = at + fn.length; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) ranges.push({ fn, start: at + fn.length + 1, end });
      from = at + fn.length;
    }
  }
  return ranges;
}

export function findUntypedParams(source) {
  const offences = [];
  const seen = new Set();
  for (const range of variadicRanges(source)) {
    const body = source.slice(range.start, range.end);
    const re = /\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}(\s*::\s*[a-zA-Z_][\w[\]]*)?/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (m[2]) continue; // explicitly cast — fine
      const absolute = range.start + m.index;
      if (seen.has(absolute)) continue; // nested calls overlap; count each parameter once
      seen.add(absolute);
      offences.push({
        line: source.slice(0, absolute).split('\n').length,
        fn: range.fn,
        expr: m[1].trim().slice(0, 60),
      });
    }
  }
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
    [findUntypedParams("sql`SELECT jsonb_build_object('a', ${v})`").length, 1, 'a BARE parameter in jsonb_build_object is DETECTED'],
    [findUntypedParams("sql`SELECT jsonb_build_object('a', ${v}::text)`").length, 0, 'an explicitly cast parameter passes'],
    [findUntypedParams("sql`SELECT jsonb_build_object('a', col, 'b', ${v})`").length, 1, 'detected alongside a column reference'],
    [findUntypedParams("sql`SELECT jsonb_build_object('a', col)`").length, 0, 'column references need no cast'],
    [findUntypedParams("sql`INSERT INTO t (a) VALUES (${v})`").length, 0, 'a parameter in a TYPED position is not flagged'],
    [findUntypedParams("sql`SELECT concat_ws('-', ${a}, ${b}::text)`").length, 1, 'only the uncast one of two is flagged'],
    [findUntypedParams("sql`SELECT jsonb_build_object('a', jsonb_build_object('b', ${v}))`").length, 1, 'a nested call reports its bare parameter exactly once'],
  ];
  const passed = controls.filter(([actual, expected]) => actual === expected).length;
  for (const [actual, expected, label] of controls) {
    console.log(`  ${actual === expected ? 'PASS' : 'FAIL'}  ${label}`);
  }
  if (passed !== controls.length) {
    console.error(`verify-untyped-jsonb-params self-test FAIL — ${passed} of ${controls.length} detector controls held`);
    process.exit(1);
  }
  console.log(`verify-untyped-jsonb-params self-test PASS — ${passed} of ${controls.length} detector controls held`);
  process.exit(0);
}

if (selfTest) runSelfTest();

const files = walk(scanRoot);
let offences = 0;
for (const file of files) {
  for (const o of findUntypedParams(readFileSync(file, 'utf8'))) {
    offences += 1;
    console.error(`  ${relative(root, file)}:${o.line}  ${o.fn}(… \${${o.expr}} …)  <- needs an explicit cast`);
  }
}

if (offences > 0) {
  console.error(
    `\nverify-untyped-jsonb-params FAIL — ${offences} bare parameter(s) inside a variadic-"any" call.\n`
    + `PostgreSQL raises 42P18 on EVERY such call, so this is a guaranteed runtime failure rather than\n`
    + `a latent risk. Add an explicit cast: \${value}::text\n`
  );
  process.exit(1);
}

console.log(`verify-untyped-jsonb-params PASS — ${files.length} source file(s) asserted, 0 untyped variadic parameters`);
