#!/usr/bin/env node
// rls-shadow-soak.mjs · RLS defense-in-depth SHADOW proof (Plane 1, 260628).
//
// Proves the non-owner, RLS-subject role (`xlooop_app`, migration 037) enforces tenant isolation at the
// DB level BEFORE any cutover — so the live flip (routing the worker through XLOOOP_RLS_APP_DATABASE_URL)
// is evidence-backed, not hoped. Run it on a NEON BRANCH (never first on prod) with both URLs set:
//
//   DATABASE_URL=<owner-conn> XLOOOP_RLS_APP_DATABASE_URL=<xlooop_app-conn> node scripts/rls-shadow-soak.mjs
//
// For every (workspace, spine-table) it asserts TWO things:
//   1. ZERO DIVERGENCE — the app role (RLS on, GUC = ws) sees EXACTLY the rows the owner sees for that ws.
//   2. RLS BITES — the app role with ws=A's GUC sees NONE of another workspace B's rows (owner sees all).
// Any divergence or any cross-tenant leak = exit 1 (do NOT cut over). No URLs = skip (exit 0) so CI is safe.
//
// The app role is stateless over the Neon HTTP driver, so the GUC must be set + read in ONE transaction
// (matches the worker's per-request set_config('xlooop.current_workspace_id', …, true) pattern).

import { neon } from '@neondatabase/serverless';

const OWNER = process.env.DATABASE_URL;
const APP = process.env.XLOOOP_RLS_APP_DATABASE_URL;
// 034-spine tables + operation_events (043: RLS'd customer spine; xlooop_app has SELECT — read parity
// + cross-tenant-leak checks apply exactly as for the spine).
const TABLES = ['task_packets', 'evidence_items', 'approval_requests', 'tool_events', 'metric_deltas', 'operation_events'];
const SAMPLE_WORKSPACES = 8; // cap

if (!OWNER || !APP) {
  console.log('rls-shadow-soak · SKIP — set DATABASE_URL (owner) + XLOOOP_RLS_APP_DATABASE_URL (xlooop_app) on a Neon branch to run.');
  process.exit(0);
}

const owner = neon(OWNER);
const app = neon(APP);
const failures = [];

// app role: rows visible for a given workspace GUC, optionally restricted to a different ws's id via WHERE.
async function appCount(table, gucWs, whereWs) {
  const where = whereWs == null ? app`` : app`WHERE workspace_id = ${whereWs}`;
  const [, rows] = await app.transaction([
    app`SELECT set_config('xlooop.current_workspace_id', ${gucWs}, true)`,
    app`SELECT count(*)::int AS n FROM ${app.unsafe(table)} ${where}`,
  ]);
  return rows[0]?.n ?? 0;
}

const main = async () => {
  // 0. Confirm the app role truly cannot bypass RLS (the whole point).
  const [role] = await owner`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'xlooop_app'`;
  if (!role) { console.error('✗ xlooop_app role missing — apply migration 037 first'); process.exit(1); }
  if (role.rolbypassrls || role.rolsuper) { console.error(`✗ xlooop_app is privileged (bypassrls=${role.rolbypassrls} super=${role.rolsuper}) — it would NOT be subject to RLS`); process.exit(1); }
  console.log('☑ xlooop_app is non-superuser + NOBYPASSRLS (subject to RLS)');

  for (const table of TABLES) {
    // workspaces that actually have rows in this table (owner sees all)
    const wsRows = await owner`SELECT DISTINCT workspace_id FROM ${owner.unsafe(table)} WHERE workspace_id IS NOT NULL LIMIT ${SAMPLE_WORKSPACES}`;
    const workspaces = wsRows.map((r) => r.workspace_id);
    if (workspaces.length === 0) { console.log(`· ${table}: no rows — skipped`); continue; }

    for (const ws of workspaces) {
      // (1) zero divergence: app(GUC=ws, no WHERE) === owner(WHERE ws)
      const [{ n: ownerN }] = await owner`SELECT count(*)::int AS n FROM ${owner.unsafe(table)} WHERE workspace_id = ${ws}`;
      const appN = await appCount(table, ws, null);
      if (appN !== ownerN) failures.push(`${table} ws=${ws}: DIVERGENCE app=${appN} owner=${ownerN}`);

      // (2) RLS bites: app(GUC=ws) must NOT see any OTHER workspace's rows
      const other = workspaces.find((w) => w !== ws);
      if (other) {
        const leak = await appCount(table, ws, other); // GUC=ws but asking for `other`'s rows
        if (leak !== 0) failures.push(`${table}: CROSS-TENANT LEAK — app(GUC=${ws}) saw ${leak} rows of ws=${other}`);
      }
    }
    console.log(`☑ ${table}: ${workspaces.length} workspace(s) — isolation holds`);
  }

  if (failures.length) {
    console.error(`\n✗ rls-shadow-soak FAILED · ${failures.length} issue(s) — DO NOT cut over:`);
    for (const f of failures) console.error(`    ${f}`);
    process.exit(1);
  }
  console.log('\n✓ rls-shadow-soak GREEN · xlooop_app enforces tenant isolation with zero divergence — cutover is evidence-backed');
  process.exit(0);
};

main().catch((e) => { console.error('rls-shadow-soak error:', e?.message || e); process.exit(1); });
