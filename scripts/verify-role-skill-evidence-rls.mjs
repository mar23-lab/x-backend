#!/usr/bin/env node
// verify-role-skill-evidence-rls.mjs · Track A (260713) · static RLS-shape gate for the mig-070
// evidence plane. WHY: verify-postgres-rls-phase2 covers only the 5 phase-2 spine tables and
// verify-rls-runtime-enforcement requires an adapter read call site (none exists for 070 until the
// read-route wave) — so without this gate the 070 tables' RLS/grant shape had NO static coverage.
// Style: phase2-style regex assertions over the migration SOURCE (no live DB); the live proof is the
// gated role-skill-evidence-live-rls.test.ts (XLOOOP_RUN_LIVE_RLS=1).

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIG = 'src/workers/db/migrations/070_role_skill_evidence_plane.sql';
const src = readFileSync(resolve(repoRoot, MIG), 'utf8');

const EVIDENCE_TABLES = [
  'role_skill_resolutions',
  'authority_denial_receipts',
  'skill_invocation_receipts',
  'closing_attestations',
];
const CATALOG_TABLES = ['template_definitions', 'template_versions', 'policy_definitions'];

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// 1. every evidence table: ENABLE RLS + a workspace policy bound to the house GUC reader
for (const t of EVIDENCE_TABLES) {
  check(new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).test(src), `${t}: missing ENABLE ROW LEVEL SECURITY`);
  const policy = new RegExp(
    `CREATE POLICY ${t}_workspace_policy ON ${t}\\s+USING \\(workspace_id = xlooop_rls_workspace_id\\(\\)\\)\\s+WITH CHECK \\(workspace_id = xlooop_rls_workspace_id\\(\\)\\)`,
  );
  check(policy.test(src), `${t}: workspace policy missing or not bound to xlooop_rls_workspace_id()`);
  // 2. SELECT-only grant to the RLS-subject role (reads may route through it; writes stay owner)
  check(new RegExp(`GRANT SELECT ON ${t}\\s+TO xlooop_app`).test(src), `${t}: missing GRANT SELECT TO xlooop_app`);
  check(!new RegExp(`GRANT[^;]*\\b(INSERT|UPDATE|DELETE)\\b[^;]*\\bON ${t}\\b`).test(src), `${t}: must NOT grant INSERT/UPDATE/DELETE to any role`);
}

// 3. RLS block is pg_proc-guarded (063 house recipe — degrade-safe when the fn is absent)
check(/IF EXISTS \(SELECT 1 FROM pg_proc WHERE proname = 'xlooop_rls_workspace_id'\)/.test(src), 'RLS block is not pg_proc-guarded (063 recipe)');

// 4. catalog stays runtime-immutable: REVOKE writes from xlooop_app on all three catalog tables
for (const t of CATALOG_TABLES) {
  check(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON ${t}\\s+FROM xlooop_app`).test(src), `${t}: missing catalog write REVOKE from xlooop_app`);
}

// 5. provenance columns present with their constraints (activation-readiness amendment)
check(/resolver_source\s+TEXT NOT NULL DEFAULT 'v0-floor'/.test(src), 'role_skill_resolutions: missing resolver_source column/default');
check(/CHECK \(resolver_source IN \('v0-floor', 'catalog', 'mixed'\)\)/.test(src), 'resolver_source: missing 3-literal CHECK');
check(/deploy_sha\s+TEXT,/.test(src), 'role_skill_resolutions: missing deploy_sha column');
check(/catalog_manifest_sha256 TEXT CHECK \(catalog_manifest_sha256 IS NULL OR catalog_manifest_sha256 ~ '\^\[a-f0-9\]\{64\}\$'\)/.test(src), 'catalog_manifest_sha256: missing column or sha256 CHECK');

// 6. denormalize-by-value doctrine: no NOT NULL catalog FK may appear on evidence tables
check(!/REFERENCES template_versions\(id\)[^,\n]*\n?[^,\n]*NOT NULL/.test(src) && !/NOT NULL[^,\n]*REFERENCES template_versions\(id\)/.test(src),
  'evidence tables: catalog FK must stay NULLABLE (empty-catalog trap)');

// ── report ─────────────────────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error('✗ role-skill-evidence RLS shape DRIFT:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`☑ role-skill-evidence-rls holds · 4 tables RLS+policy+SELECT-grant · catalog REVOKEs · provenance columns · nullable catalog FK (${MIG})`);
