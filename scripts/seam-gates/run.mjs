#!/usr/bin/env node
// scripts/seam-gates/run.mjs
// P1 (2026-06-04) · Manifest-driven seam-gate runner.
//
// Consolidates the boilerplate-duplicated scripts/verify-*boundary*.mjs family (each was a
// hand-rolled read()/check()/finish() harness) into ONE runner + a declarative manifest.json.
// Each gate is a list of checks over a set of source/JSON files; a check passes only if every
// present clause passes (AND). Exit non-zero on any failure — so `npm run verify:<id>` aliases
// just repoint to `node scripts/seam-gates/run.mjs --gate <id>` with identical pass/fail behaviour.
//
//   node scripts/seam-gates/run.mjs                 # run ALL gates in the manifest
//   node scripts/seam-gates/run.mjs --gate <id>     # run one gate (repeatable)
//   node scripts/seam-gates/run.mjs --list          # list gate ids
//   node scripts/seam-gates/run.mjs --compare-legacy scripts/verify-X.mjs --gate <id>
//                                                   # parity tool: run the legacy script + the
//                                                   # manifest gate, assert identical exit status
//
// Check clause grammar (all optional, AND-combined) per { id, file, ... }:
//   includesAll: [str]      substring(s) present in the (optionally sliced/lowercased) file text
//   includesNone: [str]     substring(s) absent
//   regex: [{pattern, flags?, mustMatch}]   RegExp.test present/absent
//   fileExists: true|false  the file alias resolves to an existing path
//   json: { op, path, value?, values?, all? }   assertion on parsed JSON (file must be json:true)
//     ops: equals | notEquals | isTrue | isFalse | includes(array contains value)
//          | supersetOf(array superset of values) | everyItem(array; all:[{field,op,value?}])
//     path: dotted; supports `a.b[].c` array-pluck (maps c over each item of a.b)
// File alias spec: { path, json?, text?(default true), caseInsensitive?, slice?:{from,to} }.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const g of manifest.gates) console.log(g.id);
  process.exit(0);
}
const wantGates = collectFlag(argv, '--gate');
const compareLegacy = singleFlag(argv, '--compare-legacy');

const gates = manifest.gates.filter((g) => wantGates.length === 0 || wantGates.includes(g.id));
if (wantGates.length && gates.length !== wantGates.length) {
  const known = new Set(manifest.gates.map((g) => g.id));
  for (const id of wantGates) if (!known.has(id)) fail(`unknown gate id: ${id}`);
}

let anyFail = false;
for (const gate of gates) {
  const { status, failures } = runGate(gate);
  console.log(JSON.stringify({ gate: gate.id, status, failures }, null, 2));
  if (status === 'PASS') console.log(`seam-gate · ${gate.id} · PASS`);
  if (status !== 'PASS') anyFail = true;

  if (compareLegacy) {
    const legacy = spawnSync('node', [compareLegacy], { cwd: REPO, encoding: 'utf8' });
    const legacyStatus = legacy.status === 0 ? 'PASS' : 'FAIL';
    const match = legacyStatus === status;
    console.log(`PARITY ${gate.id}: manifest=${status} legacy(${path.basename(compareLegacy)})=${legacyStatus} -> ${match ? 'MATCH' : 'MISMATCH'}`);
    if (!match) anyFail = true;
  }
}
process.exit(anyFail ? 1 : 0);

// ---- gate evaluation -------------------------------------------------------
function runGate(gate) {
  const files = {};
  for (const [alias, spec] of Object.entries(gate.files || {})) files[alias] = resolveFile(spec);
  const failures = [];
  for (const check of gate.checks || []) {
    try {
      if (!evalCheck(check, files)) failures.push({ id: check.id, ...(check.detail ? { detail: check.detail } : {}) });
    } catch (err) {
      failures.push({ id: check.id, error: String(err && err.message || err) });
    }
  }
  return { status: failures.length ? 'FAIL' : 'PASS', failures };
}

function resolveFile(spec) {
  const abs = path.join(REPO, spec.path);
  const exists = fs.existsSync(abs);
  let text = exists ? fs.readFileSync(abs, 'utf8') : '';
  if (spec.slice) {
    const i = text.indexOf(spec.slice.from);
    const j = spec.slice.to ? text.indexOf(spec.slice.to, i + 1) : text.length;
    text = (i >= 0 && j >= 0) ? text.slice(i, j) : ''; // fail-closed exactly like the legacy indexOf slicers
  }
  const cased = spec.caseInsensitive ? text.toLowerCase() : text;
  let parsed;
  if (spec.json && exists) { try { parsed = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { parsed = undefined; } }
  return { exists, text: cased, raw: text, json: parsed, caseInsensitive: !!spec.caseInsensitive };
}

function evalCheck(check, files) {
  const f = files[check.file];
  if (!f && (check.includesAll || check.includesNone || check.regex || check.json || 'fileExists' in check)) {
    throw new Error(`check ${check.id} references unknown file alias ${check.file}`);
  }
  if ('fileExists' in check) { if (f.exists !== check.fileExists) return false; }
  if (check.includesAll) {
    for (const s of check.includesAll) if (!f.text.includes(f.caseInsensitive ? s.toLowerCase() : s)) return false;
  }
  if (check.includesNone) {
    for (const s of check.includesNone) if (f.text.includes(f.caseInsensitive ? s.toLowerCase() : s)) return false;
  }
  if (check.regex) {
    for (const r of check.regex) {
      const matched = new RegExp(r.pattern, r.flags || '').test(f.raw);
      if (r.mustMatch && !matched) return false;
      if (r.mustMatch === false && matched) return false;
    }
  }
  if (check.json) { if (!evalJson(check.json, f.json)) return false; }
  return true;
}

function evalJson(spec, root) {
  const val = getPath(root, spec.path);
  switch (spec.op) {
    case 'equals': return val === spec.value;
    case 'notEquals': return val !== spec.value;
    case 'isTrue': return val === true;
    case 'isFalse': return val === false;
    case 'includes': return Array.isArray(val) && val.includes(spec.value);
    case 'supersetOf': return Array.isArray(val) && spec.values.every((v) => val.includes(v));
    case 'everyItem':
      return Array.isArray(val) && val.every((item) => spec.all.every((c) => evalJson({ op: c.op, path: c.field, value: c.value }, item)));
    default: throw new Error(`unknown json op: ${spec.op}`);
  }
}

function getPath(obj, p) {
  if (p == null || p === '') return obj;
  const segs = p.split('.');
  let cur = obj;
  for (let i = 0; i < segs.length; i++) {
    if (cur == null) return undefined;
    let seg = segs[i];
    const pluck = seg.endsWith('[]');
    if (pluck) seg = seg.slice(0, -2);
    cur = seg ? cur[seg] : cur;
    if (pluck) {
      if (!Array.isArray(cur)) return undefined;
      const rest = segs.slice(i + 1).join('.');
      return rest ? cur.map((x) => getPath(x, rest)) : cur.map((x) => x);
    }
  }
  return cur;
}

// ---- arg helpers -----------------------------------------------------------
function collectFlag(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
  return out;
}
function singleFlag(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
function fail(msg) { console.error(`seam-gates runner · ${msg}`); process.exit(2); }
