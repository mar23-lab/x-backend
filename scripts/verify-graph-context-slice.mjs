#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const failures = [];
const requiredRepos = ['mb-p', 'xcp-platform', 'xlooop-xcp-demo', 'xlooop-x-biz', 'xlooop-x-docs', 'xlooop-x-front'];

function json(rel) { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }
function check(id, ok, detail = {}) { if (!ok) failures.push({ id, ...detail }); }

const model = json('data/graph-context-slice.json');
const repos = new Set((model.repo_summary || []).map((row) => row.repo).filter(Boolean));
const nodeRepos = new Set((model.nodes || []).map((node) => node.repo).filter(Boolean));

check('schema', model.schema_version === 'xlooop.graph_context_slice.v1');
check('sqlite_export_mode', model.source_mode === 'owner_local_sqlite_export');
check('no_raw_content', model.source?.raw_content_included === false && model.metrics?.raw_content_included === false);
check('browser_sqlite_blocked', model.source?.browser_sqlite_access_allowed === false);
check('nodes_exported', (model.nodes || []).length >= 20, { count: model.nodes?.length });
for (const repo of requiredRepos) {
  check(`repo_summary_present:${repo}`, repos.has(repo) || nodeRepos.has(repo), { repos: Array.from(repos) });
}
for (const workspaceId of ['mbp-private', 'xcp-platform', 'xlooop', 'x-biz', 'x-docs', 'x-front']) {
  check(`workspace_ref_present:${workspaceId}`, Boolean(model.workspace_refs?.[workspaceId]), { workspace_refs: model.workspace_refs });
}

console.log(JSON.stringify({
  status: failures.length ? 'FAIL' : 'PASS',
  nodes_exported: model.nodes.length,
  repos: Array.from(repos).slice(0, 12),
  failures,
}, null, 2));
process.exit(failures.length ? 1 : 0);
