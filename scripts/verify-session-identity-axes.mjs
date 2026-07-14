#!/usr/bin/env node
// verify-session-identity-axes.mjs · Wave B (260707) · the 4-identity-axes + audited-mode contract gate.
//
// WHY: the new UI (§112.2) requires Role/OperatingMode/SessionMode/Visibility returned as FOUR SEPARATE
// session fields, never fused; and every operating-mode flip must be audited. This freezes:
//   T1 · GET /api/v1/session returns an `identity` block carrying all four axes.
//   T2 · PATCH /api/v1/session/mode validates the mode (isOperatingMode) before persisting (no free-text).
//   T3 · the mode write is AUDITED — setOperatingModeRow INSERTs into audit_logs in its transaction.
// Adversarial: drop an axis, or the isOperatingMode guard, or the audit INSERT → FAIL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = 'src/workers/routes/session.ts';
const MODE = 'src/workers/routes/session-mode.ts';
const STORE = 'src/workers/dal/session-preferences-store.ts';
const fail = [];
const read = (rel) => { const p = path.join(ROOT, rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };

// T1 · GET /session identity block carries all four axes.
const s = read(SESSION);
if (!s) { fail.push(`${SESSION} · missing`); }
else {
  const idBlock = s.match(/identity\s*=\s*\{[\s\S]*?\}/);
  const body = idBlock ? idBlock[0] : '';
  for (const axis of ['role', 'operating_mode', 'session_mode', 'visibility']) {
    if (!new RegExp(`\\b${axis}\\b`).test(body)) {
      fail.push(`${SESSION} · identity block is missing the '${axis}' axis (the 4 axes must be returned separately)`);
    }
  }
}

// T2 · PATCH validates the mode before persisting.
const m = read(MODE);
if (!m) { fail.push(`${MODE} · missing`); }
else {
  if (!/isOperatingMode\(/.test(m)) fail.push(`${MODE} · PATCH no longer validates via isOperatingMode() — a free-text mode could be persisted`);
  if (!/setOperatingMode\(/.test(m)) fail.push(`${MODE} · PATCH no longer calls dal.setOperatingMode()`);
}

// T3 · the mode write is audited.
const st = read(STORE);
if (!st) { fail.push(`${STORE} · missing`); }
else {
  const fn = st.match(/export async function setOperatingModeRow[\s\S]*?\n}/);
  const fnBody = fn ? fn[0] : '';
  if (!/INSERT INTO audit_logs/.test(fnBody) || !/operating_mode_change/.test(fnBody)) {
    fail.push(`${STORE} · setOperatingModeRow no longer writes an audit_logs 'operating_mode_change' row — mode flips must be audited`);
  }
}

if (fail.length) {
  console.error('✗ session-identity-axes · FAIL — the 4-axis identity / audited-mode contract regressed:');
  for (const v of fail) console.error(`    ${v}`);
  process.exit(1);
}
console.log('☑ session-identity-axes · PASS · /session returns role+operating_mode+session_mode+visibility · PATCH validates + audits');
process.exit(0);
