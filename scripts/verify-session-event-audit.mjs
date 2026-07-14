#!/usr/bin/env node
// verify-session-event-audit.mjs · A-W1 · token/session-lifecycle audit-coverage gate (260707).
//
// WHY: migration 048 widened audit_logs.target_type to accept 'api_token'/'session', enabling the
// enterprise-auditor requirement "who minted/revoked which connector token, when". Those audit writes live
// in the token route handlers; a refactor that drops one would silently blind the trail with no test
// failing. This gate freezes the coverage: each required lifecycle point must call the canonical
// appendAuditLog writer with the correct action AND target_type. Prevention > detection.
//
// Scope note (deliberate, F6): GET /api/v1/session is POLLED by the frontend, so a per-session audit row
// would be noise, not signal — sign-in auditing belongs on a discrete Clerk session.created webhook (a
// separate future increment), NOT the session poll. This gate therefore covers the two DISCRETE, valuable
// events: connector token mint + revoke.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Required audit points: (file, action, target_type). Extend this list as new discrete auth events are added.
const REQUIRED = [
  { file: 'src/workers/routes/developer-access.ts', action: 'customer_token_mint', target_type: 'api_token' },
  { file: 'src/workers/routes/developer-access.ts', action: 'customer_token_revoke', target_type: 'api_token' },
];

const WINDOW = 500; // chars around the action literal in which the audit call + target_type must appear

const violations = [];
for (const { file, action, target_type } of REQUIRED) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) { violations.push(`${file} · not found`); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  const actionRe = new RegExp(`action:\\s*'${action}'`);
  const m = src.match(actionRe);
  if (!m) { violations.push(`${file} · missing audit action '${action}' (lifecycle event no longer audited)`); continue; }
  // Window around the action literal must contain the canonical writer + the exact target_type.
  const start = Math.max(0, m.index - WINDOW);
  const win = src.slice(start, m.index + WINDOW);
  if (!/appendAuditLog\(/.test(win)) {
    violations.push(`${file} · action '${action}' not written via appendAuditLog() (use the canonical DAL audit writer)`);
  }
  // Negative-lookahead style exactness: the target_type must be exactly 'api_token', not a prefix-alike.
  const ttRe = new RegExp(`target_type:\\s*'${target_type}'(?![a-zA-Z0-9_])`);
  if (!ttRe.test(win)) {
    violations.push(`${file} · action '${action}' does not target target_type '${target_type}' (table/target swap?)`);
  }
}

if (violations.length) {
  console.error('✗ session-event-audit · FAIL — token/session lifecycle audit coverage regressed:');
  for (const v of violations) console.error(`    ${v}`);
  console.error('  Each connector-token mint/revoke must appendAuditLog with target_type api_token (migration 048).');
  process.exit(1);
}

console.log(`☑ session-event-audit · PASS · ${REQUIRED.length} token-lifecycle events audited (mint + revoke)`);
process.exit(0);
