#!/usr/bin/env node
// seed-legitimate-mbp-catalog.mjs · R47.2 · 2026-05-28
//
// Reads the operator-owned data files (data/spaces.json + data/ws-projects.json)
// and produces a SQL transaction that seeds the LEGITIMATE MB-P catalog into
// the live Neon DB:
//
//   1. 6 real workspaces (mbp-private, xcp-platform, xlooop, x-biz, x-docs, x-front)
//   2. operator as workspace_member of each (so they can access via R45 fallback)
//   3. 21 real projects under their correct workspace_id
//   4. Cleanup of the fabricated rows from R47.1 (the "Infrastructure", "Claims
//      discipline", etc. that lived under the synthetic Xlooop Internal workspace)
//   5. Initial scope_binding on 3 selected projects (MB-P governance · XCP roadmap
//      · Xlooop product) demonstrating the pattern · operator can change/remove
//
// Authority: data/spaces.json + data/ws-projects.json are operator-supplied
// SSOT. This script is idempotent; safe to re-run.
//
// Usage:
//   DATABASE_URL='postgres://...' node scripts/seed-legitimate-mbp-catalog.mjs
//
// OR pipe stdout to psql:
//   node scripts/seed-legitimate-mbp-catalog.mjs --dry-run | psql "$DATABASE_URL"

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const OPERATOR_USER_ID = process.env.OPERATOR_USER_ID || 'user_3EINskyClTUBH6Obs9G46gvnBE4';
const OPERATOR_OWNER_GRAPH = 'owner-graph-marat-basyrov';

const spaces = JSON.parse(readFileSync(resolve(REPO_ROOT, 'data/spaces.json'), 'utf-8'));
const wsProjects = JSON.parse(readFileSync(resolve(REPO_ROOT, 'data/ws-projects.json'), 'utf-8'));

const operatorWorkspaces = spaces.filter(
  (s) => s.kind === 'workspace' && s.owner_graph_id === OPERATOR_OWNER_GRAPH,
);

if (operatorWorkspaces.length === 0) {
  console.error('No operator workspaces found in data/spaces.json — check owner_graph_id filter.');
  process.exit(1);
}

// Build the SQL transaction
const lines = [];
lines.push('-- R47.2 · legitimate MB-P catalog seed · generated from data/spaces.json + ws-projects.json');
lines.push('-- Operator: ' + OPERATOR_USER_ID + ' · owner_graph: ' + OPERATOR_OWNER_GRAPH);
lines.push('-- Generated: ' + new Date().toISOString());
lines.push('');
lines.push('BEGIN;');
lines.push('');

// 1. Workspaces
lines.push('-- ============================================================');
lines.push('-- 1. Workspaces (' + operatorWorkspaces.length + ' real workspaces from data/spaces.json)');
lines.push('-- ============================================================');
for (const w of operatorWorkspaces) {
  const id = sqlString(w.id);
  const name = sqlString(w.name);
  const ownerUserId = sqlString(OPERATOR_USER_ID);
  const slug = sqlString(w.id);  // reuse the id as slug for stable URLs
  lines.push(`INSERT INTO workspaces (id, name, owner_user_id, slug) VALUES (${id}, ${name}, ${ownerUserId}, ${slug}) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now();`);
}
lines.push('');

// 2. Workspace memberships — operator is owner of each
lines.push('-- ============================================================');
lines.push('-- 2. Operator as owner of each workspace (so R45.12 fallback can find membership)');
lines.push('-- ============================================================');
for (const w of operatorWorkspaces) {
  lines.push(`INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at, activated_by) VALUES (${sqlString(w.id)}, ${sqlString(OPERATOR_USER_ID)}, 'owner', 'active', now(), ${sqlString(OPERATOR_USER_ID)}) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner', status = 'active';`);
}
lines.push('');

// 3. Projects (all 21 across the 6 workspaces)
lines.push('-- ============================================================');
lines.push('-- 3. Projects (mirrors data/ws-projects.json shape · real operator projects)');
lines.push('-- ============================================================');
let projectCount = 0;
for (const [wsId, projects] of Object.entries(wsProjects)) {
  // Skip workspaces not in the operator-owned set (e.g. aps-pty-ltd which is andrey-p)
  if (!operatorWorkspaces.some((w) => w.id === wsId)) continue;
  for (const p of projects) {
    projectCount += 1;
    const meta = {
      stage: p.stage || null,
      intents: p.intents ?? null,
      signoff: p.signoff ?? null,
      health: p.health || null,
      domain_id: p.domain_id || null,
    };
    lines.push(`INSERT INTO projects (id, workspace_id, name, status, description, metadata) VALUES (${sqlString(p.id)}, ${sqlString(wsId)}, ${sqlString(p.name)}, 'active', ${sqlString(p.description || p.sub || '')}, ${sqlString(JSON.stringify(meta))}::jsonb) ON CONFLICT (id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, name = EXCLUDED.name, description = EXCLUDED.description, metadata = EXCLUDED.metadata, updated_at = now();`);
  }
}
lines.push('');

// 4. Cleanup fabricated R47.1 rows (under the synthetic Xlooop Internal workspace)
lines.push('-- ============================================================');
lines.push('-- 4. Cleanup fabricated R47.1 rows (under synthetic org_3EIO8Y workspace)');
lines.push('-- ============================================================');
const FABRICATED_PROJECT_IDS = [
  'proj_mbp_governance', 'proj_mbp_intake', 'proj_mbp_private',
  'proj_mbp_infrastructure', 'proj_mbp_claims', 'proj_mbp_posture',
  'proj_mbp_investor', 'proj_mbp_security',
];
const FABRICATED_EVENT_IDS = Array.from({ length: 15 }, (_, i) => 'evt_seed_' + String(i + 1).padStart(3, '0'));
lines.push(`DELETE FROM operation_events WHERE id = ANY(ARRAY[${FABRICATED_EVENT_IDS.map(sqlString).join(',')}]);`);
lines.push(`DELETE FROM projects WHERE id = ANY(ARRAY[${FABRICATED_PROJECT_IDS.map(sqlString).join(',')}]);`);
lines.push('');

// 5. Seed scope_binding on 3 anchor projects to demonstrate the pattern
lines.push('-- ============================================================');
lines.push('-- 5. Scope-binding demonstrations · 3 anchor projects');
lines.push('-- ============================================================');
const ANCHOR_BINDINGS = [
  { project_id: 'mbp-ops', filters: ['claude-session-*', 'operator'], tools: ['claude', 'operator'] },
  { project_id: 'xcp-roadmap', filters: ['claude-session-*', 'codex-session-*'], tools: ['claude', 'codex'] },
  { project_id: 'xlooop-product', filters: ['claude-session-*', 'operator'], tools: ['claude', 'operator'] },
];
for (const a of ANCHOR_BINDINGS) {
  const binding = {
    version: 1,
    combine: 'any',
    filters: [
      { type: 'actor_in', values: a.filters },
      { type: 'source_tool_in', values: a.tools },
    ],
  };
  lines.push(`UPDATE projects SET scope_binding = ${sqlString(JSON.stringify(binding))}::jsonb, scope_binding_updated_at = now(), scope_binding_updated_by = ${sqlString(OPERATOR_USER_ID)}, updated_at = now() WHERE id = ${sqlString(a.project_id)};`);
}
lines.push('');

lines.push('COMMIT;');
lines.push('');

// Verification SELECTs (run by psql post-commit)
lines.push('-- Verification:');
lines.push('SELECT \'workspaces\' as t, COUNT(*) FROM workspaces UNION ALL SELECT \'projects\', COUNT(*) FROM projects UNION ALL SELECT \'workspace_members\', COUNT(*) FROM workspace_members WHERE user_id = ' + sqlString(OPERATOR_USER_ID) + ' AND status = \'active\';');

const sql = lines.join('\n');

function sqlString(s) {
  if (s === null || s === undefined) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

if (process.argv.includes('--dry-run')) {
  process.stdout.write(sql);
  process.exit(0);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not set. Use --dry-run to print SQL instead.');
  process.exit(1);
}

// Pipe to psql
const psql = spawn('psql', [dbUrl], { stdio: ['pipe', 'inherit', 'inherit'] });
psql.stdin.write(sql);
psql.stdin.end();
psql.on('exit', (code) => {
  console.log(`\n--- seed complete · ${projectCount} projects · ${operatorWorkspaces.length} workspaces · exit=${code} ---`);
  process.exit(code || 0);
});
