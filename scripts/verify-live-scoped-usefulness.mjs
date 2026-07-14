#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceMap = readJson('data/operational-area-source-map.json');
const tree = readJson('data/workspace-tree-read-model.json');
const stream = readJson('data/operations-live-stream.json');
const areas = Array.isArray(sourceMap.areas) ? sourceMap.areas : [];
const failures = [];
const warnings = [];
const visibleP0 = areas.filter((area) => area.p0_visible_route);

if (!visibleP0.length) failures.push('no P0 visible operational areas declared');
for (const area of visibleP0) {
  const useful = area.live_scoped_rows > 0;
  const honestBlocker = area.source_binding_status === 'blocking_setup_gap'
    && area.blocking_setup_gap?.exact_missing_source
    && area.blocking_setup_gap?.next_safe_action;
  if (!useful && !honestBlocker) failures.push(`${area.area_id} has zero live scoped rows without exact setup blocker`);
  if (!useful && honestBlocker) warnings.push(`${area.area_id} blocked by source binding: ${area.blocking_setup_gap.exact_missing_source}`);
}

const projectRows = (tree.workspaces || []).flatMap((workspace) => (workspace.projects || []).map((project) => ({ workspace, project })));
for (const { workspace, project } of projectRows) {
  if (project.source_binding_status === 'blocking_setup_gap' && !project.setup_gap?.exact_missing_source) {
    failures.push(`${workspace.id}/${project.id} blocker lacks exact missing source`);
  }
}

emit({
  verifier: 'verify-live-scoped-usefulness',
  status: failures.length ? 'FAIL' : 'PASS',
  metrics: {
    operations_stream_rows: (stream.rows || []).length,
    p0_visible_area_count: visibleP0.length,
    p0_live_useful_count: visibleP0.filter((area) => area.live_scoped_rows > 0).length,
    p0_honest_blocker_count: visibleP0.filter((area) => area.source_binding_status === 'blocking_setup_gap').length,
    p0_zero_without_blocker: sourceMap.metrics?.p0_zero_usefulness_without_blocker_count || 0,
  },
  warnings,
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
  fs.writeFileSync(path.join(outRoot, 'live-scoped-usefulness.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.verifier} · ${report.status} · p0=${report.metrics.p0_visible_area_count} · blockers=${report.metrics.p0_honest_blocker_count}`);
  for (const warning of report.warnings) console.warn(`warn: ${warning}`);
}
