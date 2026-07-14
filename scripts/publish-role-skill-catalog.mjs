#!/usr/bin/env node
// publish-role-skill-catalog.mjs · OAR-W3 (260713) · deterministic customer-safe role/skill catalog
// publisher (house pattern: scripts/seed-legitimate-mbp-catalog.mjs, with three hardening deltas).
//
//   node scripts/publish-role-skill-catalog.mjs                      # DRY-RUN (default): SQL to stdout
//   node scripts/publish-role-skill-catalog.mjs --apply              # OPERATOR-NAMED: psql $DATABASE_URL
//   … [--workspace <ws_id>] [--approval-ref <ref>] [--approved-by <id>]
//
// Deltas vs the seed precedent (approved plan, Track B):
//   1. DRY-RUN IS THE DEFAULT; --apply is explicit. Publication to any real DB is operator-named.
//   2. NO timestamps or random ids in the emitted SQL — two runs are byte-identical (determinism gate
//      diffs them). Timestamps exist only in the publish receipt file.
//   3. IMMUTABILITY PRE-CHECK: existing (template_key, version, content_sha256) triplets are read FIRST;
//      same key+version with a DIFFERENT hash = exit 1 with zero SQL emitted (ON CONFLICT DO NOTHING in
//      the SQL is only a race belt — it must never be the thing that "handles" a hash drift silently).
//
// The runtime app role cannot do any of this: mig-070 REVOKEs catalog writes from xlooop_app; this script
// runs out-of-band with the operator's DSN. RESTRICTED/internal_sensitive content is rejected BEFORE any
// SQL exists (classification whitelist in validateCatalog).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  parseCatalog, validateCatalog, buildRows, buildSql, immutabilityCheck, sha256Hex,
} from './lib/role-skill-catalog.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = 'docs/contracts/role-skill-catalog.json';
const AGENT_ROLES_PATH = 'docs/contracts/agent-roles.yml';

// ── args ─────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const argValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};
const workspaceId = argValue('--workspace');
const approvalRef = argValue('--approval-ref') ?? 'oar-w3-catalog-v1';
const approvedBy = argValue('--approved-by') ?? 'operator';

// ── load + validate ──────────────────────────────────────────────────────────────────────────────
const catalogText = readFileSync(resolve(repoRoot, CATALOG_PATH), 'utf8');
const catalog = parseCatalog(catalogText);

// agent-key disjointness: the 4 automation agents are a file-only SSOT and must never enter the catalog
const agentSrc = readFileSync(resolve(repoRoot, AGENT_ROLES_PATH), 'utf8');
const agentKeys = [...agentSrc.matchAll(/^\s*"([^"]+)":\s*$/gm)].map((m) => m[1]);

const errs = validateCatalog(catalog, { agentKeys });
if (errs.length) {
  console.error(`✗ catalog validation FAILED (${errs.length}):`);
  for (const e of errs) console.error(`  ✗ ${e}`);
  process.exit(1);
}

// ── provenance ───────────────────────────────────────────────────────────────────────────────────
const sourceSha = execFileSync('git', ['hash-object', CATALOG_PATH], { cwd: repoRoot, encoding: 'utf8' }).trim();
const rows = buildRows(catalog, { sourceSha, approvalRef });
const catalogSha = sha256Hex(rows.map((r) => r.content_sha256).join('\n'));

// ── immutability pre-check (BEFORE any SQL is emitted) ──────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL;
let checked = false;
let toEmit = rows;
if (dbUrl) {
  const q = `SELECT td.template_key || '|' || tv.version || '|' || tv.content_sha256
             FROM template_versions tv JOIN template_definitions td ON td.id = tv.template_id
             WHERE td.category IN ('role','skill','pack','tool')`;
  const out = spawnSync('psql', [dbUrl, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' });
  if (out.status !== 0) {
    console.error(`✗ immutability pre-check query failed: ${out.stderr?.slice(0, 300)}`);
    process.exit(1);
  }
  const triplets = out.stdout.split('\n').filter(Boolean).map((line) => {
    const [template_key, version, content_sha256] = line.split('|');
    return { template_key, version, content_sha256 };
  });
  const { conflicts, skips, publishable } = immutabilityCheck(rows, triplets);
  if (conflicts.length) {
    console.error(`✗ IMMUTABILITY VIOLATION — same key+version, different content hash (${conflicts.length}); NO SQL emitted:`);
    for (const c of conflicts) console.error(`  ✗ ${c.key}@${c.version} existing=${c.existing_hash.slice(0, 12)} new=${c.new_hash.slice(0, 12)} — bump the version instead`);
    process.exit(1);
  }
  for (const s of skips) console.error(`· skip (already published, identical hash): ${s.key}@${s.version}`);
  toEmit = publishable;
  checked = true;
} else if (APPLY) {
  console.error('✗ --apply requires DATABASE_URL');
  process.exit(1);
} else {
  console.error('⚠ dry-run without DATABASE_URL: immutability pre-check UNVERIFIED (SQL below assumes a fresh catalog)');
}

const sqlText = buildSql(toEmit, { workspaceId, approvedBy });

// ── emit ─────────────────────────────────────────────────────────────────────────────────────────
if (!APPLY) {
  process.stdout.write(sqlText + '\n');
  console.error(`☑ dry-run · entries=${rows.length} publishable=${toEmit.length} · catalog_sha=${catalogSha.slice(0, 8)} · source_sha=${sourceSha.slice(0, 8)} · immutability=${checked ? 'checked' : 'UNVERIFIED'}`);
  process.exit(0);
}

const apply = spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1'], { input: sqlText, encoding: 'utf8' });
if (apply.status !== 0) {
  console.error(`✗ apply FAILED: ${apply.stderr?.slice(0, 500)}`);
  process.exit(1);
}

// publish receipt (file artifact — timestamps allowed HERE, not in the SQL)
const receiptDir = resolve(repoRoot, 'docs/audits/receipts');
if (!existsSync(receiptDir)) mkdirSync(receiptDir, { recursive: true });
const receipt = {
  schema_id: 'xlooop.role_skill_catalog_publish_receipt.v1',
  catalog_version: catalog.catalog_version,
  catalog_sha256: catalogSha,
  source_sha: sourceSha,
  approval_ref: approvalRef,
  approved_by: approvedBy,
  workspace_binding: workspaceId ?? null,
  entries: rows.map((r) => ({ key: r.key, category: r.category, version: r.version, content_sha256: r.content_sha256 })),
  published: toEmit.map((r) => `${r.key}@${r.version}`),
  applied_at: new Date().toISOString(),
  target_host: (() => { try { return new URL(dbUrl).host; } catch { return 'unknown'; } })(),
};
const receiptPath = resolve(receiptDir, `role-skill-catalog-publish-${catalogSha.slice(0, 8)}.json`);
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.error(`☑ published ${toEmit.length}/${rows.length} entries · receipt: ${receiptPath}`);
