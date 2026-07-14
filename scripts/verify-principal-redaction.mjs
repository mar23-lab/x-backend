#!/usr/bin/env node
// verify-principal-redaction.mjs · A-W4.1 (260707) · customer-safe principal-id redaction gate.
//
// WHY: authorized_by_user_id (the raw human principal) is now SELECTed onto the event read model so the
// accountable roles can see WHO authorized a write. The hard invariant (PRINCIPAL_INSTRUMENT_LINEAGE.md
// §Customer-safe redaction) is that a raw internal user id must NEVER reach a low-trust surface. This gate
// freezes three things so a refactor can't silently open that leak:
//   t1 · the read exposes the column at all (feature wired — else the redaction has nothing to guard).
//   t2 · EVERY customer-facing event projection wraps normalizeEventRow with redactPrincipalForRole — a
//        bare `.map(normalizeEventRow)` that returns the raw principal unredacted is forbidden.
//   t3 · redactPrincipalForRole is FAIL-CLOSED — it exposes via an explicit accountable ALLOW-LIST and
//        redacts everything else; a deny-list (default-expose) would leak any unlisted/new role.
//
// Prevention > detection: this fails the build, not a post-hoc audit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = 'src/workers/dal/event-store.ts';
const violations = [];

const abs = path.join(ROOT, STORE);
if (!fs.existsSync(abs)) {
  violations.push(`${STORE} · event store missing`);
} else {
  const src = fs.readFileSync(abs, 'utf8');

  // t1 · the principal column is SELECTed (feature wired).
  if (!/SELECT[\s\S]*?authorized_by_user_id[\s\S]*?FROM operation_events/.test(src)) {
    violations.push(`${STORE} · t1: authorized_by_user_id is not SELECTed onto the event read model`);
  }

  // t2 · no bare .map(normalizeEventRow) in a customer projection — every projection must run the row
  // through redactPrincipalForRole. A bare map returns the raw principal to whatever role called.
  const bareMap = src.match(/\.map\(\s*normalizeEventRow\s*\)/g) || [];
  if (bareMap.length) {
    violations.push(`${STORE} · t2: ${bareMap.length} bare .map(normalizeEventRow) — raw principal escapes redaction; wrap with redactPrincipalForRole(..., opts.role)`);
  }
  // …and the redaction wrap must actually be present + threaded off the caller's role.
  if (!/redactPrincipalForRole\(\s*normalizeEventRow\([^)]*\)\s*,\s*opts\.role\s*\)/.test(src)) {
    violations.push(`${STORE} · t2: no redactPrincipalForRole(normalizeEventRow(...), opts.role) projection found`);
  }

  // t3 · fail-closed: the exposure decision is an ACCOUNTABLE allow-list, returned as-is only on a hit;
  // the redaction (null) is the ELSE branch. A deny-list phrasing ("redact when role in {client,viewer}")
  // is rejected — it default-exposes unknown roles.
  const helper = src.match(/export function redactPrincipalForRole[\s\S]*?\n}/);
  if (!helper) {
    violations.push(`${STORE} · t3: redactPrincipalForRole not found/exported`);
  } else {
    const body = helper[0];
    const usesAllowList = /PRINCIPAL_ACCOUNTABLE_ROLES\.has\(role\)\s*\?\s*row\s*:\s*\{\s*\.\.\.row,\s*authorized_by_user_id:\s*null/.test(body);
    if (!usesAllowList) {
      violations.push(`${STORE} · t3: redactPrincipalForRole is not fail-closed (must expose via an accountable allow-list and null-out otherwise)`);
    }
  }
}

if (violations.length) {
  console.error('✗ principal-redaction · FAIL — the customer-safe principal-id invariant regressed:');
  for (const v of violations) console.error(`    ${v}`);
  console.error('  authorized_by_user_id must never reach a low-trust role. See docs/governance/PRINCIPAL_INSTRUMENT_LINEAGE.md §Customer-safe redaction.');
  process.exit(1);
}

console.log('☑ principal-redaction · PASS · principal exposed to accountable roles only · fail-closed · every projection redacts');
process.exit(0);
