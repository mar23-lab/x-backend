#!/usr/bin/env node
// verify-role-skill-catalog-parity.mjs · OAR-W3 (260713) · BLOCKING parity/exposure gate for the
// customer-safe role/skill catalog. Asserts, on every ci-local run:
//   1. the catalog contract validates (schema, classification whitelist, referential integrity,
//      forbidden markers) against the LIVE agent-roles.yml key set (file-only SSOT disjointness);
//   2. the publisher dry-run is byte-DETERMINISTIC (two in-process runs, diffed);
//   3. the dry-run SQL carries no forbidden markers / internal_sensitive tier;
//   4. the kernel parity projection produces well-formed RoleSkillBinding rows for every role→skill ref;
//   5. the customer reader carries the schema-tolerant classification predicate (safe-tier-only by
//      construction) — template-policy-store.ts;
//   6. the evidence packet's published-entry count matches the catalog (doc-drift check).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  parseCatalog, validateCatalog, buildRows, buildSql, toRoleSkillBindings, FORBIDDEN_MARKERS,
} from './lib/role-skill-catalog.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// 1. validate against live agent keys
const catalog = parseCatalog(readFileSync(resolve(repoRoot, 'docs/contracts/role-skill-catalog.json'), 'utf8'));
const agentSrc = readFileSync(resolve(repoRoot, 'docs/contracts/agent-roles.yml'), 'utf8');
const agentKeys = [...agentSrc.matchAll(/^\s*"([^"]+)":\s*$/gm)].map((m) => m[1]);
check(agentKeys.length >= 4, `agent-roles.yml key extraction broke (got ${agentKeys.length}, expected >=4)`);
const errs = validateCatalog(catalog, { agentKeys });
for (const e of errs) failures.push(`catalog: ${e}`);

// 2. publisher dry-run byte-determinism (two full CLI runs)
const run = () => execFileSync('node', ['scripts/publish-role-skill-catalog.mjs'], { cwd: repoRoot, encoding: 'utf8' });
let sql1 = '';
try {
  sql1 = run();
  const sql2 = run();
  check(sql1 === sql2, 'publisher dry-run is NOT byte-deterministic across two runs');
  check(sql1.startsWith('BEGIN;'), 'dry-run SQL does not start with BEGIN;');
} catch (err) {
  failures.push(`publisher dry-run failed: ${String(err).slice(0, 200)}`);
}

// 3. exposure scan of the emitted SQL
for (const marker of FORBIDDEN_MARKERS) {
  check(!sql1.includes(marker), `dry-run SQL contains forbidden marker '${marker}'`);
}
check(!sql1.includes('internal_sensitive'), 'dry-run SQL contains the internal_sensitive tier');
check(!/\d{4}-\d{2}-\d{2}T\d{2}/.test(sql1), 'dry-run SQL contains a timestamp (breaks determinism doctrine)');

// 4. kernel-parity projection shape
const bindings = toRoleSkillBindings(catalog);
check(bindings.length > 0, 'catalog projects ZERO RoleSkillBinding rows (roles reference no skills?)');
for (const b of bindings) {
  for (const f of ['role', 'skill_key', 'skill_version', 'lifecycle', 'actions', 'allowed_tools', 'denied_tools', 'source']) {
    check(b[f] !== undefined, `binding ${b.role}→${b.skill_key}: missing kernel field '${f}'`);
  }
  check(b.source === 'catalog', `binding ${b.role}→${b.skill_key}: source must be 'catalog'`);
}

// 5. reader predicate (safe-tier-only by construction, schema-tolerant)
const readerSrc = readFileSync(resolve(repoRoot, 'src/workers/dal/template-policy-store.ts'), 'utf8');
check(
  readerSrc.includes(`COALESCE(to_jsonb(td)->>'classification', 'customer_visible') IN ('public', 'customer_visible')`),
  'template-policy-store.ts: missing the schema-tolerant classification predicate',
);

// 6. evidence-packet count parity (doc drift)
const packetPath = resolve(repoRoot, 'docs/audits/OAR_W3_EVIDENCE_PACKET.md');
if (existsSync(packetPath)) {
  const packet = readFileSync(packetPath, 'utf8');
  check(
    packet.includes(`${catalog.entries.length} published customer-safe entries`) || packet.includes(`**${catalog.entries.length}**`),
    `OAR_W3_EVIDENCE_PACKET.md does not state the current catalog entry count (${catalog.entries.length})`,
  );
}

const rows = buildRows(catalog, { sourceSha: '0'.repeat(40), approvalRef: 'gate' });
const sqlShape = buildSql(rows);
check((sqlShape.match(/INSERT INTO template_versions/g) ?? []).length === catalog.entries.length,
  'version INSERT count != catalog entry count');

if (failures.length) {
  console.error('✗ role-skill-catalog parity DRIFT:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`☑ role-skill-catalog parity holds · ${catalog.entries.length} entries valid · dry-run deterministic + marker-clean · ${bindings.length} kernel bindings well-formed · reader safe-tier predicate present`);
