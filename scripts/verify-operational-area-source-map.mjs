#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceMap = readJson('data/operational-area-source-map.json');
const areas = Array.isArray(sourceMap.areas) ? sourceMap.areas : [];
const failures = [];
const investor = sourceMap.area_by_id?.['x-biz-investor-readiness'] || areas.find((area) => area.area_id === 'x-biz-investor-readiness');

if (sourceMap.schema_version !== 'xlooop.operational_area_source_map.v1') failures.push('schema mismatch');
if (sourceMap.browser_sqlite_access_allowed !== false) failures.push('browser SQLite access must be false');
if (sourceMap.raw_private_content_included !== false) failures.push('raw private content must be excluded');
if (areas.length < 21) failures.push(`expected at least 21 operational areas, got ${areas.length}`);
for (const area of areas) {
  if (!area.area_id || !area.workspace_id || !area.space_id || !area.template_id) failures.push(`${area.area_id || 'unknown'} missing identity fields`);
  if (!['bound_live_rows', 'blocking_setup_gap', 'metadata_only_gap'].includes(area.source_binding_status)) failures.push(`${area.area_id} has invalid binding status ${area.source_binding_status}`);
}
if (!investor) failures.push('x-biz-investor-readiness missing');
else if (!(investor.live_scoped_rows > 0 || investor.source_binding_status === 'blocking_setup_gap')) failures.push('x-biz investor readiness must have live rows or an explicit blocking setup gap');
else if (investor.source_binding_status === 'blocking_setup_gap' && !investor.blocking_setup_gap?.exact_missing_source) failures.push('x-biz investor readiness blocker must name exact missing source');
if (Number(sourceMap.metrics?.p0_zero_usefulness_without_blocker_count || 0) !== 0) failures.push('P0 zero-usefulness route without blocker detected');

emit({
  verifier: 'verify-operational-area-source-map',
  status: failures.length ? 'FAIL' : 'PASS',
  metrics: sourceMap.metrics || {},
  investor_readiness: investor ? {
    live_scoped_rows: investor.live_scoped_rows,
    source_binding_status: investor.source_binding_status,
    missing_sources: investor.missing_sources,
  } : null,
  failures,
});
if (failures.length) process.exit(1);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function emit(report) {
  const readOnly = process.env.XCP_VERIFY_READONLY !== '0';
  const outRoot = readOnly ? path.join('/private/tmp', 'xlooop-xcp-demo-readonly-audits') : path.join(repoRoot, 'docs', 'audits');
  fs.mkdirSync(outRoot, { recursive: true });
  fs.writeFileSync(path.join(outRoot, 'operational-area-source-map.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.verifier} · ${report.status} · areas=${report.metrics.area_count || 0}`);
}
