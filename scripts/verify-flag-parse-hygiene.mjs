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
// P-2 REMEDIATION (260729). Two defects:
//
//   1. THE SELF-TEST TESTED THIS FILE'S REGEX, NOT THE GATE. Five of nine assertion callsites were
//      `expect('…', scanLine('<string literal defined right here>'))`. `scanLine` and the strings are
//      both defined in this file, so the test proved a regex matches a string. It proved nothing
//      about whether a real offending line in a real `src/workers` tree drives a non-zero exit. The
//      self-test now seeds .ts files into a temp tree, SPAWNS this gate at it, and OBSERVES the exit.
//   2. AN EMPTY SCAN TREE READ AS CLEAN. `tsFiles()` returning zero files left `offenders` empty and
//      the gate printed "all *_ENABLED flag reads route through envFlagTrue" — a false zero on a
//      moved or mis-resolved src/workers. The denominator is now asserted and printed.
//
// EXIT CODES.  0 = measured clean   1 = quote-intolerant read(s) found   2 = COULD NOT MEASURE
//
//   node scripts/verify-flag-parse-hygiene.mjs
//   node scripts/verify-flag-parse-hygiene.mjs --self-test         # OBSERVES a red
//   node scripts/verify-flag-parse-hygiene.mjs --scan-root=<dir>   # aim it elsewhere

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_SCAN_ROOT = 'src/workers';
const READER = 'src/workers/lib/env-flag.ts';
const argv = process.argv.slice(2);
const selfTest = argv.includes('--self-test');
const scanArg = argv.find((a) => a.startsWith('--scan-root='));
const SCAN_ROOT = scanArg ? path.resolve(scanArg.slice('--scan-root='.length)) : path.join(repoRoot, DEFAULT_SCAN_ROOT);

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
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export function scanLine(line) {
  if (isCommentLine(line)) return false;
  return OFFENDER.test(line);
}

// =================================================================================================
// HELPER-SHAPED READS — the per-LINE blind spot (FGH-3, 260729)
// =================================================================================================
// OFFENDER above matches `_ENABLED` and `'true'` ON THE SAME LINE. A flag read behind a LOCAL helper
// splits those two facts across two lines and is therefore invisible to it:
//
//     const enabled = (v?: string) => v?.trim().toLowerCase() === 'true';   // names no flag
//     ...
//     single_intake: enabled(env.SINGLE_INTAKE_ENABLED),                    // names no 'true'
//
// `src/workers/routes/health.ts` shipped exactly this and read SIX flags through it — the same
// quote-intolerant class this gate exists to prevent, fully invisible to the gate.
//
// DETECTION RULE — two conjuncts, BOTH required:
//   (1) DEFINITION SHAPE. A locally-defined arrow or `function` whose body compares one of its OWN
//       PARAMETERS against the literal 'true' using === / == / !== / !=.
//   (2) APPLICATION. That same helper is called at least once IN THE SAME FILE with an argument
//       naming an env var — a SCREAMING_SNAKE token, which is how every flag in this worker is named
//       (this is what catches CHAT_HISTORY_PERSISTENCE_REQUIRED, which has no `_ENABLED` suffix).
//
// Requiring BOTH is what keeps the rule from firing on a query-string read such as
// `ctx.req.query('cause_only') === 'true'` (no helper definition, and no env-shaped argument).
//
// WHAT THIS STILL CANNOT SEE — stated because a gate that silently misses a shape is the very defect
// being fixed here. All of the following remain INVISIBLE:
//   - a helper IMPORTED from another module (the comparison and the callsite are in different files;
//     this scan is per-file and does no cross-module dataflow);
//   - an ALIASED helper (`const f = enabled;` then `f(env.X_ENABLED)`) — the alias's definition is a
//     bare identifier, not a comparison;
//   - a helper reached through an object or array (`FLAGS.read(env.X_ENABLED)`, `handlers[k](...)`);
//   - a comparison against a non-literal (`=== TRUE_LITERAL`, `=== someConst`);
//   - a destructured read (`const { X_ENABLED } = env;` then `X_ENABLED === 'true'` on a later line
//     WITHOUT the flag name — the per-line rule catches it only when the name is on the line);
//   - helper-calling-helper indirection of depth > 1.
// The sanctioned fix is unchanged and unambiguous: call envFlagTrue directly.

const ENV_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const TRUE_COMPARE = /[!=]==?\s*'true'/;

function matchParenAt(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function matchBraceAt(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Parameter identifiers from a raw parameter list: `value?: string`, `v = ''`, `{ a }` -> names.
function paramNames(raw) {
  return raw.split(',')
    .map((p) => (p.trim().match(/^[A-Za-z_$][\w$]*/) || [''])[0])
    .filter(Boolean);
}

// The body text of a helper defined at `defEnd` (offset just past its parameter list).
function helperBody(src, defEnd) {
  const win = src.slice(defEnd, defEnd + 600);
  const arrowRel = win.indexOf('=>');
  const braceRel = win.indexOf('{');
  // `function name(p) { ... }` — braced body, no arrow before it.
  if (braceRel !== -1 && (arrowRel === -1 || braceRel < arrowRel)) {
    const close = matchBraceAt(src, defEnd + braceRel);
    if (close !== -1) return src.slice(defEnd + braceRel, close + 1);
  }
  if (arrowRel === -1) return '';
  const afterArrow = defEnd + arrowRel + 2;
  const rest = src.slice(afterArrow, afterArrow + 600);
  const braced = rest.match(/^\s*\{/);
  if (braced) {
    const open = afterArrow + rest.indexOf('{');
    const close = matchBraceAt(src, open);
    if (close !== -1) return src.slice(open, close + 1);
  }
  // Concise arrow body: to the first `;` or newline at depth 0.
  let end = afterArrow, depth = 0;
  while (end < src.length) {
    const c = src[end];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (c === ';' && depth === 0) break;
    else if (c === '\n' && depth === 0) break;
    end++;
  }
  return src.slice(afterArrow, end);
}

// Locally-defined helpers whose body compares a PARAMETER to 'true'.
export function trueComparingHelpers(src) {
  const found = [];
  const defRe = /(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s+)?\(([^)]*)\)|(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\))/g;
  for (const m of src.matchAll(defRe)) {
    const name = m[1] || m[3];
    const params = paramNames(m[2] !== undefined ? m[2] : m[4] || '');
    if (!name || !params.length) continue;
    const body = helperBody(src, m.index + m[0].length);
    if (!body || !TRUE_COMPARE.test(body)) continue;
    // The comparison must involve one of the helper's OWN parameters.
    if (!params.some((p) => new RegExp('\\b' + p + '\\b').test(body))) continue;
    found.push({ name, line: src.slice(0, m.index).split('\n').length, params });
  }
  return found;
}

// Callsites of `name(...)` whose argument names an env var, excluding the definition itself.
export function envShapedCallsites(src, name) {
  const sites = [];
  const callRe = new RegExp('(?:^|[^A-Za-z0-9_$.])' + name + '\\s*\\(', 'g');
  for (const m of src.matchAll(callRe)) {
    const open = m.index + m[0].length - 1;
    // Skip the definition: `const name = (` / `function name(`.
    const before = src.slice(Math.max(0, m.index - 30), m.index + m[0].length);
    if (/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=\n]*)?=\s*(?:async\s+)?\($/.test(before)) continue;
    if (/function\s+[A-Za-z_$][\w$]*\s*\($/.test(before)) continue;
    const close = matchParenAt(src, open);
    if (close === -1) continue;
    const arg = src.slice(open + 1, close);
    if (ENV_TOKEN.test(arg)) {
      sites.push({ line: src.slice(0, m.index).split('\n').length, arg: arg.trim().slice(0, 60) });
    }
  }
  return sites;
}

export function helperOffenders(src, shown) {
  const out = [];
  for (const h of trueComparingHelpers(src)) {
    const sites = envShapedCallsites(src, h.name);
    for (const s of sites) {
      out.push(`${shown}:${s.line}  ${h.name}(${s.arg})  <- local helper defined at line ${h.line} compares a parameter to 'true' (quote-intolerant)`);
    }
  }
  return out;
}

export function runChecks(files) {
  const offenders = [];
  for (const abs of files) {
    const shown = path.relative(repoRoot, abs);
    if (shown === READER || shown.includes('__tests__')) continue;
    const src = fs.readFileSync(abs, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (scanLine(line)) offenders.push(`${shown}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
    offenders.push(...helperOffenders(src, shown));
  }
  return offenders;
}

// =================================================================================================
// SELF-TEST — the SUBJECT is this gate as a PROCESS; exit codes are OBSERVED from a child
// =================================================================================================
if (selfTest) {
  const rows = [];
  const problems = [];
  const record = (label, ok) => { rows.push('  ' + (ok ? 'PASS' : 'FAIL').padEnd(6) + '  ' + label); if (!ok) problems.push(label); };
  const run = (root) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scan-root=' + root], { encoding: 'utf8' });
  const seedTree = (name, body) => {
    const root = path.join(tmp, name);
    fs.mkdirSync(path.join(root, 'routes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'routes', 'flags.ts'), body);
    return root;
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xl-flagparse-selftest-'));

  // (1) CANNOT MEASURE — a scan root that does not exist must exit 2, never 0.
  const goneRun = run(path.join(tmp, 'no-such-root'));
  record(`MISSING SCAN ROOT exits 2 "cannot measure" (observed exit=${goneRun.status})`, goneRun.status === 2);

  // (2) CANNOT MEASURE — a scan root holding zero .ts files must exit 2. This is the false zero the
  //     remediation closes: before it, an empty tree printed the hygiene claim.
  const emptyRoot = path.join(tmp, 'empty'); fs.mkdirSync(emptyRoot, { recursive: true });
  const emptyRun = run(emptyRoot);
  record(`EMPTY INPUT SET exits 2 "cannot measure" (observed exit=${emptyRun.status})`, emptyRun.status === 2);

  // (3) CONTROL — the REAL src/workers tree must be MEASURABLE: a verdict (0 or 1), never 2.
  //     HISTORY, stated rather than hidden: until 260729 the real tree exited 1 on two
  //     quote-intolerant reads — src/workers/crons/tenant-projection-dispatch.ts:8 and
  //     src/workers/index.ts:447. The ORIGINAL gate at the production checkout
  //     (e40bf927fe90d8b557858c86ac30eb5256a3d7ba) exited 1 on them too, so that red was never a
  //     regression introduced by the rewrite — it was a latent defect nothing was watching,
  //     because this gate was referenced by no npm script. Both reads now route through
  //     envFlagTrue, and the gate runs in ci-local as verify:flag-parse-hygiene, which is what
  //     makes a future red visible. This case still accepts 0 OR 1 deliberately: it asserts
  //     MEASURABILITY, not a verdict — the clean-tree proof is case (7).
  const controlRun = run(path.join(repoRoot, DEFAULT_SCAN_ROOT));
  record(`CONTROL: the real src/workers tree is MEASURABLE, verdict not "cannot measure" (observed exit=${controlRun.status})`,
    controlRun.status === 0 || controlRun.status === 1);

  // (4)-(6) MUTANTS — each offending FORM must bite on its own, in a real file, through a real run.
  const forms = [
    ['strict ===', "export const on = String(ctx.env.FOO_ENABLED || '') === 'true';\n"],
    ['strict !==', "export function guard(env) { if (env.BAR_ENABLED !== 'true') return null; return 1; }\n"],
    ['lowercase ===', "export const on = String(env.BAZ_ENABLED || '').toLowerCase() === 'true';\n"],
  ];
  forms.forEach(([name, body], i) => {
    const r = run(seedTree(`mutant-${i}`, body));
    const out = (r.stdout || '') + (r.stderr || '');
    record(`MUTANT: ${name} comparison drives exit 1 (observed exit=${r.status})`, r.status === 1);
    record(`MUTANT: the offending file and line are NAMED (${name})`, /routes\/flags\.ts:1/.test(out));
  });

  // (7) CONTROL — the sanctioned reader must NOT bite, or "route through envFlagTrue" is unfollowable.
  const tolerantRun = run(seedTree('control-tolerant', 'export const on = envFlagTrue(ctx.env.FOO_ENABLED);\n'));
  record(`CONTROL: envFlagTrue(...) exits 0 (observed exit=${tolerantRun.status})`, tolerantRun.status === 0);

  // (8) CONTROL — a COMMENT describing the historical form must NOT bite. This is the exemption the
  //     rule text promises; without a proof it is only a claim.
  const commentRun = run(seedTree('control-comment', "// true only when FOO_ENABLED === 'true' (route-read)\nexport const on = envFlagTrue(ctx.env.FOO_ENABLED);\n"));
  record(`CONTROL: a comment describing the old form exits 0 (observed exit=${commentRun.status})`, commentRun.status === 0);

  // (9)-(11) MUTANTS — the HELPER-SHAPED class (FGH-3). Each is the health.ts defect reproduced: the
  //     comparison and the flag name are on DIFFERENT lines, so the per-line rule cannot see them.
  //     These must bite through a real spawned run, or the extension is a claim rather than a gate.
  const helperForms = [
    ['arrow helper + _ENABLED flag (the exact health.ts shape)',
      "const enabled = (v?: string) => v?.trim().toLowerCase() === 'true';\n"
      + 'export const posture = { single_intake: enabled(env.SINGLE_INTAKE_ENABLED) };\n'],
    ['function-declaration helper + _ENABLED flag',
      "function isOn(value) { return String(value).toLowerCase() === 'true'; }\n"
      + 'export const on = isOn(ctx.env.TENANT_PROJECTION_QUEUE_ENABLED);\n'],
    ['helper applied to a flag with NO _ENABLED suffix (CHAT_HISTORY_PERSISTENCE_REQUIRED)',
      "const enabled = (v?: string) => v?.trim().toLowerCase() === 'true';\n"
      + 'export const strict = enabled(env.CHAT_HISTORY_PERSISTENCE_REQUIRED);\n'],
  ];
  helperForms.forEach(([name, body], i) => {
    const r = run(seedTree(`helper-mutant-${i}`, body));
    const out = (r.stdout || '') + (r.stderr || '');
    record(`MUTANT (helper-shaped): ${name} drives exit 1 (observed exit=${r.status})`, r.status === 1);
    record(`MUTANT (helper-shaped): the local helper is NAMED as the cause (${name})`,
      /local helper defined at line/.test(out));
  });

  // (12) CONTROL — a query-string read is NOT a flag read. `ctx.req.query('cause_only') === 'true'`
  //      ships in graph.ts / events.ts / customer-lineage.ts today. If the new rule fired on it the
  //      gate would be unfollowable, because there is no envFlagTrue to route a query param through.
  const queryRun = run(seedTree('control-query-param',
    "export const causeOnly = ctx.req.query('cause_only') === 'true';\n"));
  record(`CONTROL: a query-string 'true' comparison does NOT bite (observed exit=${queryRun.status})`,
    queryRun.status === 0);

  // (13) CONTROL — a local 'true'-comparing helper that is NEVER applied to an env-shaped value is
  //      not a flag-parse defect. Both conjuncts of the rule are required; this proves the second.
  const nonFlagRun = run(seedTree('control-helper-no-flag',
    "const isYes = (v?: string) => v?.trim().toLowerCase() === 'true';\n"
    + "export const answer = isYes(body.userAnswer);\n"));
  record(`CONTROL: a 'true'-comparing helper never applied to an env var does NOT bite (observed exit=${nonFlagRun.status})`,
    nonFlagRun.status === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n  SELF-TEST · verify-flag-parse-hygiene (J-W0 · FGH-1/2/3)');
  console.log('  ' + '-'.repeat(84));
  for (const r of rows) console.log(r);
  console.log('  ' + '-'.repeat(84));
  if (problems.length) {
    console.error(`  SELF-TEST FAIL — ${problems.length} case(s) wrong; this gate is a false-green.\n`);
    process.exit(1);
  }
  const passed = rows.length - problems.length;
  console.log(`  SELF-TEST PASS — ${passed}/${rows.length}, every case an OBSERVED exit code from a spawned run of this gate.\n`);
  process.exit(0);
}

// =================================================================================================
// THE GATE
// =================================================================================================
console.log('verify-flag-parse-hygiene · J-W0 (FGH-1/2)');

if (!fs.existsSync(SCAN_ROOT)) {
  console.error(`  ✗ CANNOT MEASURE — scan root missing: ${SCAN_ROOT}`);
  console.error('  A vanished root must not silently shrink the subject. Re-point this gate, then re-run.');
  process.exit(2);
}

const files = tsFiles(SCAN_ROOT);

// EXIT 2 — EMPTY INPUT SET. `files` is the denominator of the hygiene claim below.
if (!files.length) {
  console.error(`  ✗ CANNOT MEASURE — ${SCAN_ROOT} exists but holds ZERO .ts files.`);
  console.error('  A gate that inspected nothing has measured nothing; that is a false zero, not hygiene.');
  process.exit(2);
}

const offenders = runChecks(files);
if (offenders.length > 0) {
  console.error(`\n✗ ${offenders.length} flag read(s) use a quote-intolerant strict/lowercase comparison — route through envFlagTrue (${READER}):`);
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`  ☑ ${files.length} .ts file(s) scanned; all *_ENABLED flag reads route through envFlagTrue (quote-tolerant)`);
console.log('\n☑ flag-parse-hygiene holds');
process.exit(0);
