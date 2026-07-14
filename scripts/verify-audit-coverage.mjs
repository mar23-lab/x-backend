#!/usr/bin/env node
// verify-audit-coverage.mjs · M5 · governance audit-coverage regression gate (260707).
//
// WHY: the enterprise auditability story rests on "every authority-critical mutation leaves an audit_logs
// row" (ACCESS_CONTROL_MATRIX.md — member role change, access approve/reject, sign-off verdict, authority
// revoke, decision record, provisioning, user-status). Those audit writes live INSIDE the DAL store
// function that performs the mutation. A refactor that drops the INSERT (or splits the function and loses
// it) would silently blind the trail with no test failing — the exact class this gate prevents.
//
// THE RULE: each pinned (file, function) below must contain an `INSERT INTO audit_logs` within its OWN
// body (parsed from `export [async] function <name>(` to the next top-level `export ` / EOF). Miss = FAIL.
// Curated allow-list (grounded from live code) → zero false positives; it freezes coverage, not style.
// Prevention > detection. New authority mutations should be ADDED here when introduced.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAL = 'src/workers/dal';

// (file · exported function · required audit sink). Grounded 260707 from the live audit_logs INSERT sites.
const REQUIRED = [
  ['workspace-member-store.ts', 'setWorkspaceMemberRoleRow'],   // member role change (owner-only, audited)
  ['access-store.ts', 'approveAccessRequestRow'],               // workspace access approve
  ['access-store.ts', 'rejectAccessRequestRow'],                // workspace access reject
  ['governance-store.ts', 'createSignOffRow'],                  // sign-off verdict (immutable)
  ['customer-authority-store.ts', 'revokeCustomerAuthorityRow'],// typed-name authority consent revoke
  ['decision-store.ts', 'createDecisionRow'],                   // decision record
  ['customer-provisioning-store.ts', 'provisionCustomerWorkspaceRow'], // customer workspace provisioning
  ['user-store.ts', 'setUserStatusRow'],                        // user status (activate/suspend)
];

// Negative lookahead so a table-swap (e.g. audit_logs_shadow) does NOT satisfy the gate — the write must
// target the real audit_logs table, not a prefix-alike.
const SINK_RE = /INSERT\s+INTO\s+audit_logs(?![_a-zA-Z0-9])/i;

/** Slice a top-level exported function's body: from its `export ... function <name>(` to the next
 *  top-level `export ` (column-0) or EOF. Returns null if the function is not found. */
function functionBody(src, name) {
  const decl = new RegExp(String.raw`export\s+(?:async\s+)?function\s+${name}\s*\(`);
  const m = src.match(decl);
  if (!m) return null;
  const start = m.index;
  const after = src.slice(start + m[0].length);
  const nextExport = after.search(/\nexport\s/);
  return nextExport === -1 ? after : after.slice(0, nextExport);
}

const violations = [];
for (const [file, fn] of REQUIRED) {
  const rel = path.join(DAL, file);
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { violations.push(`${rel} · file not found`); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  const body = functionBody(src, fn);
  if (body === null) { violations.push(`${rel} · function ${fn}() not found (renamed/removed?)`); continue; }
  if (!SINK_RE.test(body)) violations.push(`${rel} · ${fn}() no longer writes an audit_logs row`);
}

if (violations.length) {
  console.error('✗ audit-coverage · FAIL — authority-critical mutation(s) lost their audit trail:');
  for (const v of violations) console.error(`    ${v}`);
  console.error('  Every authority mutation must INSERT INTO audit_logs (ACCESS_CONTROL_MATRIX.md). Restore the write.');
  process.exit(1);
}

console.log(`☑ audit-coverage · PASS · ${REQUIRED.length} authority-critical mutations each audited`);
process.exit(0);
