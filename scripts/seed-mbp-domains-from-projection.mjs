#!/usr/bin/env node
// seed-mbp-domains-from-projection.mjs · 2026-07-17
//
// Mirrors the operator's CANONICAL life-domain taxonomy from MB-P into synthetic_domains.
//
// WHY THIS EXISTS
// The cockpit's "Departments" were never the operator's real domains. Migration
// 011_personal_life_seed.sql invented six (Creative/Family/Learning/Work/Health/Finance) that
// overlap MB-P's canonical DOMAIN_REGISTRY.yml by only two entries; nine real domains (career, car,
// government, home, travels, personal-branding, hobbies, todos, companies) were missing entirely.
// 011's own rationale — that the LEM v4 detector needs a "pre-accepted baseline" — does not hold:
// the detector never queries synthetic_domains, its DDC counts PROJECTS not domains, and
// is_pre_accepted_root has zero readers. Those rows are inert.
//
// WHY A PRODUCER SCRIPT AND NOT A MIGRATION
// A migration would commit the operator's real personal domain map (government, finances, health)
// into the customer-facing repo forever. That is exactly 011's mistake. The registry stays in MB-P
// (SSOT); only rows land in the DB; nothing personal enters git. This script runs on the OPERATOR
// MACHINE, which is why it may read the staged projection at all — verify-no-mbp-runtime-dependency
// scans src/workers/** + functions/** and holds scripts/ out of scope BY DESIGN. The deployed Worker
// still works with /WIP/MB-P deleted.
//
// THE CONTRACT IT IMPLEMENTS
// Migration 028 added `kind` and `source_domain_id` for precisely this and has never been used
// (source_domain_id is null on every live row): the one-way "mirror lens" — the MB-P node stays SSOT
// and is NEVER mutated from Xlooop. Rows are written kind='life', visibility='operator_only',
// source_domain_id='mbp:domain:<id>'.
//
// Usage:
//   node scripts/seed-mbp-domains-from-projection.mjs --dry-run          # print SQL, touch nothing
//   DATABASE_URL='postgres://...' node scripts/seed-mbp-domains-from-projection.mjs
//   ... --archive-invented    # also archive the 6 seeded roots (never DELETE — HR-ARCHIVE)
//
// Idempotent: ON CONFLICT (workspace_id, slug) DO UPDATE.

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const PROJECTION = resolve(repo, 'data/mbp-operations-projection.json');
const WORKSPACE_ID = 'mbp-private';
// The Clerk id, not the string 'marat'. Live rows already carry this; 011's placeholder never reached prod.
const OPERATOR_USER_ID = process.env.OPERATOR_USER_ID || 'user_3EINskyClTUBH6Obs9G46gvnBE4';
const SEED_SOURCE = 'mbp_domain_registry_projection';
const INVENTED_SEED_SOURCE = 'r51_gamma_personal_life_seed';
const archiveInvented = process.argv.includes('--archive-invented');

function fail(msg) { console.error(`seed-mbp-domains · ${msg}`); process.exit(2); }
const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);

if (!existsSync(PROJECTION)) {
  fail(`staged projection missing: ${PROJECTION}\n  Run: node scripts/ensure-mbp-projection-fresh.mjs`);
}
const projection = JSON.parse(readFileSync(PROJECTION, 'utf8'));

// Fail closed on a non-external-safe export. ensure-mbp-projection-fresh already refuses these, but
// this script can be run standalone — the redaction posture must never be assumed.
const mode = projection.operation_mode || projection.redaction_state;
if (!['metadata_readonly', 'metadata_only'].includes(String(mode))) {
  fail(`REFUSED — projection operation_mode='${mode}' is not external-safe.`);
}
if (projection.private_raw_content_included === true) {
  fail('REFUSED — projection carries private raw content; it must not be staged into the DB.');
}

const domains = Array.isArray(projection.domains) ? projection.domains : null;
if (!domains) {
  fail('projection has no domains[] block.\n  The MB-P exporter must be updated first (see\n  MB-P _sys/scripts/export_mbp_to_xlooop_projection.py · _build_domains), then re-staged.');
}
if (!domains.length) fail('projection domains[] is empty — refusing to archive the existing taxonomy for nothing.');

// A `path` here would mean the vault leaked a REDACTED_PATHS-adjacent field. Refuse rather than store it.
const leaked = domains.filter((d) => 'path' in d);
if (leaked.length) fail(`REFUSED — ${leaked.length} domain(s) carry a 'path' field; the exporter must omit it.`);

const lines = [];
lines.push('BEGIN;');
lines.push('');
lines.push(`-- MB-P canonical domain taxonomy -> synthetic_domains (${domains.length} domains)`);
lines.push(`-- Source: ${projection._meta?.producer || 'mbp projection'} · generated_at ${projection.generated_at}`);
lines.push('-- MB-P remains SSOT; these rows are a read-only mirror (migration 028 source_domain_id).');
lines.push('');

for (const d of domains) {
  const id = `sd_mbp_${String(d.domain_id).replace(/-/g, '_')}`;
  const metadata = JSON.stringify({
    seed_source: SEED_SOURCE,
    mbp_domain_id: d.domain_id,
    sensitivity: d.sensitivity,
    has_agent: !!d.has_agent,
    has_timeline: !!d.has_timeline,
    has_contacts: !!d.has_contacts,
    mirror_readonly: true,
  });
  lines.push(
    `INSERT INTO synthetic_domains (id, workspace_id, slug, label, description, owner_user_id, visibility, edit_role, binding, binding_version, status, kind, source_domain_id, metadata, created_at, updated_at)`
  );
  lines.push(
    `VALUES (${q(id)}, ${q(WORKSPACE_ID)}, ${q(d.domain_id)}, ${q(d.label)}, ${q(`Mirror of the MB-P ${d.label} domain (SSOT: MB-P DOMAIN_REGISTRY.yml).`)}, ${q(OPERATOR_USER_ID)}, 'operator_only', 'owner', '{"version":1,"combine":"any","filters":[]}'::jsonb, 1, 'active', 'life', ${q(d.source_node || `mbp:domain:${d.domain_id}`)}, ${q(metadata)}::jsonb, NOW(), NOW())`
  );
  // Conflict target is the SLUG index, not id: the invented seeds already occupy `health` in this
  // workspace under a DIFFERENT id (sd_seed_mbp_health). ON CONFLICT (id) would miss that and the
  // insert would fail on idx_sd_workspace_slug. Matching the real unique index adopts the existing
  // row instead — which is also why `finance` (invented) and `finances` (MB-P) do NOT collide and
  // the stale `finance` row must be archived separately below.
  lines.push(
    `ON CONFLICT (COALESCE(workspace_id, '__cross__'), slug) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, kind = EXCLUDED.kind, source_domain_id = EXCLUDED.source_domain_id, metadata = EXCLUDED.metadata, owner_user_id = EXCLUDED.owner_user_id, status = 'active', updated_at = NOW();`
  );
  lines.push('');
}

if (archiveInvented) {
  lines.push('-- Retire the agent-invented roots. ARCHIVE, never DELETE (HR-ARCHIVE).');
  lines.push('-- Scoped by seed_source so a slug adopted above (e.g. health) is not re-archived:');
  lines.push('-- the UPDATE above already set its seed_source to the projection value.');
  lines.push(
    `UPDATE synthetic_domains SET status = 'archived', updated_at = NOW() WHERE workspace_id = ${q(WORKSPACE_ID)} AND metadata->>'seed_source' = ${q(INVENTED_SEED_SOURCE)} AND status <> 'archived';`
  );
  lines.push('');
}

lines.push('-- Verification (printed by psql):');
lines.push(
  `SELECT slug, label, kind, status, source_domain_id, metadata->>'sensitivity' AS sensitivity FROM synthetic_domains WHERE workspace_id = ${q(WORKSPACE_ID)} ORDER BY status, slug;`
);
lines.push('COMMIT;');

const sql = lines.join('\n') + '\n';

if (process.argv.includes('--dry-run')) {
  process.stdout.write(sql);
  process.exit(0);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) fail('DATABASE_URL not set. Use --dry-run to print the SQL instead.');

const psql = spawn('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'inherit', 'inherit'] });
psql.stdin.write(sql);
psql.stdin.end();
psql.on('exit', (code) => {
  console.log(`\nseed-mbp-domains · ${domains.length} domains mirrored · archive_invented=${archiveInvented} · exit=${code}`);
  process.exit(code || 0);
});
