#!/usr/bin/env node
// verify-gate-self-reference.mjs — META-GATE P-2 (a gate about gates).
//
// INVARIANT. A verification gate may not assert a function or constant that it itself defines.
// The subject under test must resolve OUTSIDE the gate file.
//
// WHY THIS EXISTS. A census of 200 `verify-*.mjs` gates across x-backend + x-ai-front measured the
// verification layer at ~1.5% load-bearing: 21.5% carry a --self-test, and only 3 of 200 have a
// self-test that OBSERVES a red. The named instance this gate was built against is
// `scripts/verify-customer-revocation-end-to-end.mjs`, which is BLOCKING in ci-local (pre-push):
// it defines `function authorize(identity, request)` INSIDE the gate, defines its fixtures INSIDE
// the gate, and then asserts that its own function returns the expected verdicts on its own
// fixtures. Production authorization (`src/workers/middleware/auth.ts`,
// `src/workers/routes/mcp-gateway.ts`) is only string-grepped for markers. Production auth can
// break arbitrarily and that gate stays green. It is named "end-to-end" and it gates every push.
//
// Fixing 200 gates by hand repeats the failure that made 36 hand-added write blocks unenforced
// until a runtime gate caught 3 more. This makes the CLASS enforceable once.
//
// WHAT IS MEASURED. Per gate: the number of assertion callsites (`checks`), and how many of those
// assert a symbol the gate itself defines (`self_referential`). A gate is a VIOLATION when it has
// at least one self-referential check AND self_referential/checks >= SELF_REF_RATIO_MAX. The ratio
// is the rule; whether the gate also reads `src/` is recorded as context, never as an exemption —
// reading three files for three string-greps does not redeem twenty self-asserted checks.
//
// RATCHET, NOT A WALL. Existing violations are recorded in a committed baseline
// (docs/contracts/GATE_SELF_REFERENCE_BASELINE.json). Only NEW violations fail. Baseline entries
// that no longer violate are reported as STALE so the list cannot rot upward, and --write-baseline
// re-locks the gains.
//
// EXIT CODES.  0 = measured clean   1 = measured, new violations   2 = COULD NOT MEASURE
// Exit 2 is distinct on purpose: "could not read the corpus" must never render as "measured clean".
//
//   node scripts/verify-gate-self-reference.mjs
//   node scripts/verify-gate-self-reference.mjs --self-test
//   node scripts/verify-gate-self-reference.mjs --json
//   node scripts/verify-gate-self-reference.mjs --write-baseline
//   node scripts/verify-gate-self-reference.mjs --roots=<dir>   # aim it elsewhere (self-test uses this)
//
// SCOPE. Single-repo by default. A cross-repo filesystem root would make this gate fail whenever the
// sibling checkout is absent, which is the runtime-filesystem-dependency anti-pattern AGENTS.md
// forbids. x-ai-front carries its own meta-gate (`wired/scripts/verify-gate-denominator.mjs`).

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { resolve, dirname, relative, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BASELINE_PATH = resolve(REPO, 'docs/contracts/GATE_SELF_REFERENCE_BASELINE.json');

const argv = process.argv.slice(2);
const selfTest = argv.includes('--self-test');
const asJson = argv.includes('--json');
const writeBaseline = argv.includes('--write-baseline');
const rootsArg = argv.find((a) => a.startsWith('--roots='));

// A gate whose MAJORITY of checks assert its own code is testing itself, not the system.
const SELF_REF_RATIO_MAX = 0.5;

// =================================================================================================
// LEXICAL SUBSTRATE
// =================================================================================================
// Blank comments, string literals, template literals and regex literals, preserving byte offsets and
// newlines so reported line numbers stay true. Shape reused verbatim from
// x-ai-front/wired/scripts/verify-people-seams.mjs Section B — that gate learned the hard way that
// without this a file's own PROSE description of a pattern is read as code.
function stripNonCode(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let i = a; i < b && i < src.length; i++) if (out[i] !== '\n') out[i] = ' '; };
  const REGEX_OK_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
  const REGEX_OK_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await']);
  const endOfTemplate = (start) => {
    let j = start + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') return j + 1;
      if (src[j] === '$' && src[j + 1] === '{') {
        let depth = 1; j += 2;
        while (j < src.length && depth > 0) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '`') { j = endOfTemplate(j); continue; }
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          j++;
        }
        continue;
      }
      j++;
    }
    return src.length;
  };
  let i = 0, lastSig = '', lastWord = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { let j = i; while (j < src.length && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); const end = j === -1 ? src.length : j + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      blank(i, j + 1); i = j + 1; lastSig = 'x'; lastWord = ''; continue;
    }
    if (c === '`') { const end = endOfTemplate(i); blank(i, end); i = end; lastSig = 'x'; lastWord = ''; continue; }
    if (c === '/' && (REGEX_OK_AFTER.has(lastSig) || REGEX_OK_KEYWORDS.has(lastWord))) {
      let j = i + 1, inClass = false, closed = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) { while (j + 1 < src.length && /[a-z]/.test(src[j + 1])) j++; blank(i, j + 1); i = j + 1; lastSig = 'x'; lastWord = ''; continue; }
    }
    if (/[A-Za-z0-9_$]/.test(c)) lastWord += c;
    else if (!/\s/.test(c)) lastWord = '';
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.join('');
}

const lineOf = (src, off) => src.slice(0, off).split('\n').length;

// Match the closing paren for the `(` at `open`; returns its offset, or -1 if unbalanced.
function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Match the closing brace for the `{` at `open`.
function matchBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Bounded body span for a function/arrow defined at `offset`. Handles BOTH braced bodies and
// concise arrow bodies (`const read = (r) => readFileSync(join(root, r), 'utf8');`), which have no
// braces at all — a naive indexOf('{') would run off into an unrelated block far below and make
// every downstream judgement about that helper fiction.
function bodySpan(stripped, offset) {
  const HORIZON = 400;
  const head = stripped.slice(offset, offset + HORIZON);
  const arrowRaw = head.indexOf('=>');
  const parenRaw = head.indexOf('(');
  let cursor = offset;
  // Skip the PARAMETER LIST first. A default value (`async function fetchJson(path, options = {})`)
  // puts a `{` before the body, so a naive search for the first brace measures the default `{}` as
  // the whole function body — and every judgement about that helper is then made on an empty string.
  if (parenRaw !== -1 && (arrowRaw === -1 || parenRaw < arrowRaw)) {
    const closeParen = matchParen(stripped, offset + parenRaw);
    if (closeParen !== -1) cursor = closeParen + 1;
  }
  const win = stripped.slice(cursor, cursor + HORIZON);
  const arrowRel = win.indexOf('=>');
  const braceRel = win.indexOf('{');
  const bracedFirst = braceRel !== -1 && (arrowRel === -1 || braceRel < arrowRel);
  const bracedAfterArrow = arrowRel !== -1 && braceRel !== -1 && braceRel > arrowRel
    && /^\s*$/.test(win.slice(arrowRel + 2, braceRel));
  if (bracedFirst || bracedAfterArrow) {
    const open = cursor + braceRel;
    const close = matchBrace(stripped, open);
    if (close !== -1) return [open, close + 1];
  }
  if (arrowRel !== -1) {
    const start = cursor + arrowRel + 2;
    let end = start, depth = 0;
    while (end < stripped.length) {
      const c = stripped[end];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if ((c === ';' || c === ',') && depth === 0) break;
      else if (c === '\n' && depth === 0) break;
      end++;
    }
    return [start, end];
  }
  return null;
}

// ACCESSORS — locally-defined helpers that reach OUTSIDE the gate (file reads, HTTP, subprocesses).
// Naming one inside an assertion is not self-reference: it is the transport, not the subject.
// `gate('…', read('src/workers/x.ts').includes('marker'))` asserts the PRODUCTION FILE; the fact that
// `read` happens to be defined locally is irrelevant. Without this exclusion the detector reports a
// gate as self-referential precisely BECAUSE it reads production source — exactly backwards.
const IO_CALLS = /\b(readFileSync|readdirSync|existsSync|statSync|readFile|fetch|spawnSync|execSync|spawn|exec|globSync|request)\s*\(/;
function accessorNames(stripped, defs) {
  const acc = new Set();
  for (const [name, d] of defs) {
    if (d.kind !== 'function' && d.kind !== 'const-fn') continue;
    const span = bodySpan(stripped, d.offset);
    if (!span) continue;
    if (IO_CALLS.test(stripped.slice(span[0], span[1]))) acc.add(name);
  }
  return acc;
}

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'this', 'null', 'true',
  'false', 'undefined', 'class', 'extends', 'super', 'import', 'export', 'from', 'default', 'async',
  'await', 'yield', 'try', 'catch', 'finally', 'throw', 'void', 'with', 'static', 'get', 'set',
]);

// =================================================================================================
// WHAT THE GATE DEFINES
// =================================================================================================
// Only symbols that constitute the gate's OWN LOGIC or its OWN FIXTURES count as a self-reference
// subject:
//   - function declarations and class declarations       (the gate's own logic)
//   - const bound to an arrow fn / function expression   (the gate's own logic)
//   - const bound to an object or array LITERAL          (the gate's own fixtures)
// Deliberately EXCLUDED, because these are derived from external input and asserting them is exactly
// what a healthy gate does:
//   - `let` / `var`             — mutable state computed while walking the subject
//   - const bound to a CALL     — e.g. `const auth = read('src/workers/middleware/auth.ts')`,
//                                 `const stripped = stripNonCode(adapter)`
//   - const bound to a scalar   — plain configuration
function definedSubjects(stripped) {
  const defs = new Map();
  const add = (name, kind, offset) => { if (name && !JS_KEYWORDS.has(name) && !defs.has(name)) defs.set(name, { kind, offset }); };

  for (const m of stripped.matchAll(/(?:^|[^A-Za-z0-9_$.])(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    add(m[1], 'function', m.index);
  }
  for (const m of stripped.matchAll(/(?:^|[^A-Za-z0-9_$.])class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    add(m[1], 'class', m.index);
  }
  for (const m of stripped.matchAll(/(?:^|[^A-Za-z0-9_$.])const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*/g)) {
    const name = m[1];
    const after = m.index + m[0].length;
    const rest = stripped.slice(after, after + 4000);
    const head = rest.replace(/^\s+/, '');
    let kind = null;
    if (/^(async\s+)?function\b/.test(head)) kind = 'const-fn';
    else if (/^\{/.test(head)) kind = 'const-object';
    else if (/^\[/.test(head)) kind = 'const-array';
    else if (/^(async\s*)?\(/.test(head)) {
      // `const f = (a, b) => …` is logic; `const x = (expr)` or `const x = fn(...)` is derived.
      const openRel = head.indexOf('(');
      const absOpen = after + (rest.length - head.length) + openRel;
      const close = matchParen(stripped, absOpen);
      if (close !== -1 && /^\s*=>/.test(stripped.slice(close + 1, close + 8))) kind = 'const-fn';
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*\s*=>/.test(head)) kind = 'const-fn';
    if (kind) add(name, kind, m.index);
  }
  return defs;
}

// =================================================================================================
// WHAT COUNTS AS AN ASSERTION
// =================================================================================================
// Accumulators: array-ish locals that collect problems. Their `.push(` is how a gate records a red.
function accumulatorNames(stripped) {
  const names = new Set();
  for (const m of stripped.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*push\s*\(/g)) {
    if (/fail|problem|violation|error|missing|issue|bad|offend|breach|defect/i.test(m[1])) names.add(m[1]);
  }
  return names;
}

// An assertion helper is either a well-known assertion name, or a LOCAL function whose body records a
// red (pushes to an accumulator, calls fail(), or exits non-zero). That second clause is what lets
// this meta-gate see hand-rolled `check()` / `expect()` / `record()` helpers, which is how most gates
// in this estate are actually written.
const BUILTIN_ASSERTIONS = /^(assert[A-Za-z0-9_$]*|ok|expect|check|must|shouldBe|verifyThat)$/;

function assertionHelpers(stripped, defs, accs) {
  const helpers = new Set();
  const bodies = new Map();
  for (const [name, d] of defs) {
    if (d.kind !== 'function' && d.kind !== 'const-fn') continue;
    const span = bodySpan(stripped, d.offset);
    if (!span) continue;
    const body = stripped.slice(span[0], span[1]);
    bodies.set(name, span);
    const recordsRed =
      [...accs].some((a) => new RegExp(a + '\\s*\\.\\s*push\\s*\\(').test(body))
      || /\bfail\s*\(/.test(body)
      || /process\s*\.\s*exit\s*\(\s*[12]\s*\)/.test(body);
    if (BUILTIN_ASSERTIONS.test(name) || recordsRed) helpers.add(name);
  }
  for (const m of stripped.matchAll(/(?:^|[^A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    if (BUILTIN_ASSERTIONS.test(m[1])) helpers.add(m[1]);
  }
  helpers.delete('require');
  return { helpers, bodies };
}

// Identifiers referenced inside an argument span, excluding property accesses (`x.FOO`) and object
// keys (`{ FOO: … }`) — neither is a symbol reference.
function identifiersIn(span) {
  const found = new Set();
  for (const m of span.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const name = m[0];
    if (JS_KEYWORDS.has(name)) continue;
    let p = m.index - 1;
    while (p >= 0 && /\s/.test(span[p])) p--;
    if (p >= 0 && span[p] === '.') continue;                       // property access
    let q = m.index + name.length;
    while (q < span.length && /\s/.test(span[q])) q++;
    if (span[q] === ':') continue;                                  // object key
    found.add(name);
  }
  return found;
}

function analyseGate(absPath, shown) {
  const src = readFileSync(absPath, 'utf8');
  const stripped = stripNonCode(src);

  // Self-protection: if the stripper mis-parses, every offset below is fiction. A gate we cannot
  // tokenise is reported as UNPARSEABLE — never silently counted as clean.
  let braces = 0, parens = 0;
  for (const ch of stripped) {
    if (ch === '{') braces++; else if (ch === '}') braces--;
    else if (ch === '(') parens++; else if (ch === ')') parens--;
  }
  if (braces !== 0 || parens !== 0) {
    return { file: shown, unparseable: true, note: `stripper unbalanced (net braces ${braces}, net parens ${parens})`, checks: 0, self_referential: 0, ratio: 0, sites: [] };
  }

  const defs = definedSubjects(stripped);
  const accs = accumulatorNames(stripped);
  const accessors = accessorNames(stripped, defs);
  const { helpers, bodies } = assertionHelpers(stripped, defs, accs);

  // Every callsite of an assertion helper, with its argument span.
  const sites = [];
  for (const m of stripped.matchAll(/(?:^|[^A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    const name = m[1];
    if (!helpers.has(name)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(stripped, open);
    if (close === -1) continue;
    sites.push({ name, start: m.index, open, close });
  }

  // Drop callsites that are (a) inside an assertion helper's OWN body — that is plumbing, not an
  // independent check — or (b) nested inside another assertion's argument span (already counted).
  const helperSpans = [...bodies.entries()].filter(([n]) => helpers.has(n)).map(([, s]) => s);
  const outer = [];
  for (const s of sites.sort((a, b) => a.start - b.start)) {
    if (helperSpans.some(([a, b]) => s.start > a && s.start < b)) continue;
    if (outer.some((o) => s.start > o.open && s.start < o.close)) continue;
    outer.push(s);
  }

  const selfRef = [];
  for (const s of outer) {
    const span = stripped.slice(s.open + 1, s.close);
    const ids = identifiersIn(span);
    const hits = [...ids].filter((id) => defs.has(id) && !helpers.has(id) && !accs.has(id) && !accessors.has(id));
    if (hits.length) selfRef.push({ line: lineOf(src, s.start), assertion: s.name, symbols: hits.sort() });
  }

  // Context only, never an exemption: does the gate resolve ANY subject outside itself? Scanned on the
  // RAW source because these references live in string literals the stripper blanks.
  const externalSubject = /(from\s+['"][^'"]*\.\.\/src\/)|(['"`]src\/)|((readFileSync|readdirSync|existsSync)\s*\([^)]*\bsrc\b)/.test(src);

  const checks = outer.length;
  const ratio = checks ? selfRef.length / checks : 0;
  return {
    file: shown,
    unparseable: false,
    checks,
    self_referential: selfRef.length,
    ratio: Number(ratio.toFixed(4)),
    external_subject: externalSubject,
    sites: selfRef,
  };
}

function isViolation(r) {
  return !r.unparseable && r.self_referential > 0 && r.ratio >= SELF_REF_RATIO_MAX;
}

// =================================================================================================
// SELF-TEST — mutation-driven, exit codes OBSERVED from a child process
// =================================================================================================
if (selfTest) {
  const rows = [];
  const problems = [];
  const record = (label, ok) => { rows.push('  ' + (ok ? 'PASS' : 'FAIL').padEnd(6) + '  ' + label); if (!ok) problems.push(label); };
  const run = (root) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--roots=' + root], { encoding: 'utf8' });

  const dir = mkdtempSync(join(tmpdir(), 'xl-selfref-selftest-'));

  // (1) CANNOT MEASURE — a root that does not exist must exit 2, never 0.
  const goneRun = run(join(dir, 'no-such-root'));
  record(`MISSING ROOT exits 2 "cannot measure" (observed exit=${goneRun.status})`, goneRun.status === 2);

  // (2) CANNOT MEASURE — a root with zero gate files must exit 2, never 0.
  const emptyDir = join(dir, 'empty'); mkdirSync(emptyDir, { recursive: true });
  const emptyRun = run(emptyDir);
  record(`EMPTY INPUT SET exits 2 "cannot measure" (observed exit=${emptyRun.status})`, emptyRun.status === 2);

  // The DONOR for both the control and the mutant is chosen DYNAMICALLY: the clean repo gate with
  // the fewest assertion callsites. Choosing dynamically means this self-test cannot rot when gates
  // are added, renamed or cleaned up, and picking the SMALLEST clean gate means the injected
  // violation is not diluted below the threshold by the donor's own honest checks — which is exactly
  // the flaw the first version of this self-test had, and which this self-test caught.
  const scriptsDir = resolve(REPO, 'scripts');
  const cleanCandidates = (existsSync(scriptsDir) ? readdirSync(scriptsDir) : [])
    .filter((e) => /^verify-.*\.mjs$/.test(e))
    .map((e) => ({ e, r: analyseGate(join(scriptsDir, e), e) }))
    .filter((x) => !x.r.unparseable && !isViolation(x.r))
    .sort((a, b) => a.r.checks - b.r.checks || a.e.localeCompare(b.e));
  // Prefer a donor that carries REAL honest checks: the mutation then has to outweigh genuine
  // assertions to cross the threshold, which is a far stronger proof than dominating an empty file.
  const donorEntry = cleanCandidates.find((x) => x.r.checks >= 2) || cleanCandidates[0] || null;

  // (3) CONTROL — a real, unmutated, non-self-referential gate must exit 0.
  const cleanDir = join(dir, 'clean'); mkdirSync(cleanDir, { recursive: true });
  if (donorEntry) copyFileSync(join(scriptsDir, donorEntry.e), join(cleanDir, donorEntry.e));
  else writeFileSync(join(cleanDir, 'verify-control.mjs'),
    "import { readFileSync } from 'node:fs';\nconst src = readFileSync('../src/x.ts', 'utf8');\nconst fails = [];\nfunction check(l, ok) { if (!ok) fails.push(l); }\ncheck('marker present', src.includes('marker'));\nprocess.exit(fails.length ? 1 : 0);\n");
  const cleanRun = run(cleanDir);
  record(`CONTROL: unmutated real gate ${donorEntry ? donorEntry.e : '(synthetic)'} exits 0 (observed exit=${cleanRun.status})`,
    cleanRun.status === 0);

  // (4) MUTANT — inject a REAL self-reference into that same REAL gate file (temp copy), observe 1.
  //     The mutation is the exact defect class: define a function and fixtures, then assert them.
  const mutantDir = join(dir, 'mutant'); mkdirSync(mutantDir, { recursive: true });
  const donorPath = donorEntry ? join(scriptsDir, donorEntry.e) : join(cleanDir, 'verify-control.mjs');
  const donorChecks = donorEntry ? donorEntry.r.checks : 0;
  const donor = readFileSync(donorPath, 'utf8');
  const needed = donorChecks + 1;   // selfRef / (donorChecks + selfRef) >= 0.5
  const mutation = [
    '',
    '// ---- INJECTED MUTATION (self-test) ----',
    'function authorizeMutant(identity) { return identity.status === "active" ? { ok: true } : { ok: false }; }',
    'const fixtureActive = { status: "active" };',
    'const fixtureRevoked = { status: "revoked" };',
    'const mutantFailures = [];',
    'function checkMutant(label, ok) { if (!ok) mutantFailures.push(label); }',
  ];
  for (let i = 0; i < needed; i++) {
    mutation.push(`checkMutant("mutant case ${i}", authorizeMutant(fixtureActive).ok === true && fixtureRevoked.status !== fixtureActive.status);`);
  }
  mutation.push('');
  writeFileSync(join(mutantDir, 'verify-mutant-selfref.mjs'), donor + mutation.join('\n'));
  const mutantRun = run(mutantDir);
  const mutantOut = (mutantRun.stdout || '') + (mutantRun.stderr || '');
  record(`MUTANT: ${needed} self-referential check(s) injected into real gate ${donorEntry ? donorEntry.e : '(synthetic)'} `
    + `(${donorChecks} honest check(s)) drives exit 1 (observed exit=${mutantRun.status})`, mutantRun.status === 1);
  record('MUTANT: the injected gate is NAMED in the failure output', /verify-mutant-selfref\.mjs/.test(mutantOut));
  record('MUTANT: the self-asserted symbol is NAMED (authorizeMutant)', /authorizeMutant/.test(mutantOut));

  // (5) THE NAMED TARGET — the detector must flag the real gate it was built against, FOR AS LONG AS
  //     THAT GATE EXISTS. If it flags it wrongly the detector is wrong; the threshold must NOT be
  //     tuned to make it pass.
  //
  //     260729: the named target was REMEDIATED — verify-customer-revocation-end-to-end.mjs was
  //     replaced by verify-customer-revocation-authority.mjs, which imports and executes the shipped
  //     store and spine authority instead of asserting its own authorize(). This branch used to
  //     `record(..., false)` when the file was absent, which meant fixing the defect broke the
  //     meta-gate's own self-test: a control that requires the defect to persist is a control that
  //     punishes the repair. The load-bearing proof of this detector is case (4) — a synthetic
  //     mutant injected into a real gate, which drives a real exit 1 — and that is unaffected.
  //     Absence is now recorded as the remediation it is, and the successor is checked for relapse.
  const target = resolve(REPO, 'scripts/verify-customer-revocation-end-to-end.mjs');
  if (existsSync(target)) {
    const r = analyseGate(target, 'scripts/verify-customer-revocation-end-to-end.mjs');
    record(`NAMED TARGET verify-customer-revocation-end-to-end.mjs is detected self-referential `
      + `(${r.self_referential}/${r.checks} checks, ratio ${r.ratio})`, isViolation(r));
    record('NAMED TARGET: its self-defined authorize() is named as the asserted symbol',
      r.sites.some((s) => s.symbols.includes('authorize')));
  } else {
    const successor = resolve(REPO, 'scripts/verify-customer-revocation-authority.mjs');
    record('NAMED TARGET remediated: verify-customer-revocation-end-to-end.mjs no longer exists', true);
    if (existsSync(successor)) {
      const r = analyseGate(successor, 'scripts/verify-customer-revocation-authority.mjs');
      record(`SUCCESSOR verify-customer-revocation-authority.mjs does NOT relapse `
        + `(${r.self_referential}/${r.checks} checks, ratio ${r.ratio})`, !isViolation(r));
    } else {
      record('SUCCESSOR verify-customer-revocation-authority.mjs present (the remediation was not silently dropped)', false);
    }
  }

  rmSync(dir, { recursive: true, force: true });
  console.log('\n  SELF-TEST · verify-gate-self-reference (META-GATE P-2)');
  console.log('  ' + '-'.repeat(84));
  for (const r of rows) console.log(r);
  console.log('  ' + '-'.repeat(84));
  if (problems.length) {
    console.error(`  SELF-TEST FAIL — ${problems.length} case(s) wrong; this meta-gate is a false-green.\n`);
    process.exit(1);
  }
  console.log(`  SELF-TEST PASS — ${rows.length}/${rows.length}, including an OBSERVED exit 1 on an injected mutant and an OBSERVED exit 2 on a missing corpus.\n`);
  process.exit(0);
}

// =================================================================================================
// THE GATE
// =================================================================================================
const roots = rootsArg ? [rootsArg.slice('--roots='.length)] : ['scripts'];

const missingRoots = [];
const files = [];
for (const r of roots) {
  const abs = resolve(REPO, r);
  if (!existsSync(abs)) { missingRoots.push(r); continue; }
  for (const e of readdirSync(abs)) {
    if (/^verify-.*\.mjs$/.test(e)) files.push({ abs: join(abs, e), shown: relative(REPO, join(abs, e)) });
  }
}

// EXIT 2 — CANNOT MEASURE. A declared root that vanished, or a corpus of zero gates, means this
// meta-gate verified NOTHING. That must never render as "measured clean".
if (missingRoots.length) {
  console.error(`  CANNOT MEASURE verify-gate-self-reference — declared root(s) missing: ${missingRoots.join(', ')}.`);
  console.error('  A vanished root must not silently shrink the subject. Re-point this gate, then re-run.');
  process.exit(2);
}
if (!files.length) {
  console.error(`  CANNOT MEASURE verify-gate-self-reference — root(s) ${roots.join(', ')} exist but hold ZERO verify-*.mjs files.`);
  console.error('  A gate that inspected nothing has measured nothing; that is a false zero, not a pass.');
  process.exit(2);
}

const results = files.map((f) => analyseGate(f.abs, f.shown)).sort((a, b) => b.ratio - a.ratio || a.file.localeCompare(b.file));
const violations = results.filter(isViolation);
const unparseable = results.filter((r) => r.unparseable);

if (writeBaseline) {
  // A baseline entry is DEBT, not an exemption — except where the violation is a DELIBERATE design,
  // in which case the reason belongs in the entry so the next reader does not re-litigate it.
  // --write-baseline must therefore CARRY FORWARD `retained_because` and `diagnosis`; regenerating
  // without them would silently strip the arguments and turn reasoned entries back into anonymous
  // debt, which is exactly how a ratchet rots upward.
  const carried = new Map();
  if (existsSync(BASELINE_PATH)) {
    for (const v of JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).violations ?? []) {
      if (v.retained_because || v.diagnosis) carried.set(v.file, { retained_because: v.retained_because, diagnosis: v.diagnosis });
    }
  }
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify({
    schema_id: 'gate_self_reference_baseline.v1',
    rule: 'A verification gate may not assert a function or constant it itself defines. Entries below are PRE-EXISTING violations, frozen so the class cannot grow. NEW violations fail the gate. Entries that stop violating are reported STALE and must be removed (run --write-baseline) so the list cannot rot upward.',
    self_ref_ratio_max: SELF_REF_RATIO_MAX,
    captured_at: new Date().toISOString().slice(0, 10),
    gates_scanned: results.length,
    violations: violations.map((v) => {
      const row = {
        file: v.file, checks: v.checks, self_referential: v.self_referential, ratio: v.ratio, external_subject: v.external_subject,
      };
      const prior = carried.get(v.file);
      if (prior && prior.retained_because) row.retained_because = prior.retained_because;
      if (prior && prior.diagnosis) row.diagnosis = prior.diagnosis;
      return row;
    }),
  }, null, 2) + '\n');
  console.log(`  baseline written: ${violations.length} violation(s) frozen across ${results.length} gate(s) -> ${relative(REPO, BASELINE_PATH)}`);
  process.exit(0);
}

let baseline = null;
if (existsSync(BASELINE_PATH)) baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const baselineFiles = new Set((baseline && baseline.violations ? baseline.violations : []).map((v) => v.file));

const fresh = violations.filter((v) => !baselineFiles.has(v.file));
const stale = [...baselineFiles].filter((f) => !violations.some((v) => v.file === f)).sort();

if (asJson) {
  console.log(JSON.stringify({
    schema_id: 'gate_self_reference_report.v1',
    gates_scanned: results.length,
    violations: violations.length,
    new_violations: fresh.length,
    stale_baseline_entries: stale.length,
    unparseable: unparseable.length,
    results,
  }, null, 2));
  process.exit(fresh.length ? 1 : 0);
}

console.log('\n  META-GATE P-2 · GATE SELF-REFERENCE (a gate may not assert what it itself defines)');
console.log('  ' + '-'.repeat(84));
console.log(`  scanned ${results.length} gate(s) under ${roots.join(', ')} · ${violations.length} violating · ${unparseable.length} unparseable`);
console.log('  ' + '-'.repeat(84));
for (const v of violations) {
  const flag = baselineFiles.has(v.file) ? 'BASELINE' : 'NEW';
  console.log(`  ${flag.padEnd(9)} ${v.file}`);
  console.log(`            ${v.self_referential}/${v.checks} checks assert symbols this gate itself defines (ratio ${v.ratio}); reads src/: ${v.external_subject}`);
  for (const s of v.sites.slice(0, 6)) console.log(`            line ${s.line}: ${s.assertion}(...) asserts ${s.symbols.join(', ')}`);
  if (v.sites.length > 6) console.log(`            ... and ${v.sites.length - 6} more`);
}
for (const u of unparseable) console.log(`  UNPARSEABLE ${u.file} — ${u.note}`);
console.log('  ' + '-'.repeat(84));

if (stale.length) {
  console.log(`  STALE BASELINE (${stale.length}) — these no longer violate; remove them so the list cannot rot upward:`);
  for (const f of stale) console.log(`    - ${f}`);
  console.log('    run: node scripts/verify-gate-self-reference.mjs --write-baseline');
  console.log('  ' + '-'.repeat(84));
}

if (fresh.length) {
  console.error(`  FAIL — ${fresh.length} NEW self-referential gate(s) (baseline holds ${baselineFiles.size}):`);
  for (const v of fresh) console.error(`    - ${v.file} (${v.self_referential}/${v.checks}, ratio ${v.ratio})`);
  console.error('  A gate must assert the SYSTEM, not its own code. Move the subject out of the gate file,');
  console.error('  or if this is genuinely pre-existing, re-baseline deliberately with --write-baseline.\n');
  process.exit(1);
}
console.log(`  PASS — ${results.length} gate(s) scanned, ${violations.length} known violation(s) held at baseline, 0 new.\n`);
process.exit(0);
