#!/usr/bin/env node
// folder-sync.mjs · W3 client · read a local folder → compute a snapshot → POST it to the cockpit.
//
// The server NEVER reads your filesystem; THIS script does (locally) and posts only {path, checksum,
// size} — never file content. The server diffs against the last baseline and files one reflection_only
// cockpit event per add/modify/delete. On-demand: run it whenever you want the folder reflected.
//
// Usage:
//   1) register once (returns a binding_id):
//      curl -s -X POST https://api.xlooop.com/api/v1/folder-sources/register \
//        -H "Authorization: Bearer $XLOOOP_TOKEN" -H 'content-type: application/json' \
//        -d '{"workspace_id":"<ws>","path":"<abs folder path>"}'
//   2) sync (repeatable):
//      XLOOOP_TOKEN=<jwt> node scripts/folder-sync.mjs \
//        --binding <binding_id> --workspace <ws> --path <abs folder path> [--api https://api.xlooop.com]
//
// Token: a Clerk session JWT for the operator (the folder routes are operator-only). Get it from the
// signed-in app (e.g. window.XcpClerk.getToken()) and export XLOOOP_TOKEN.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const API = arg('api', process.env.XLOOOP_API_BASE_URL || 'https://api.xlooop.com').replace(/\/$/, '');
const TOKEN = process.env.XLOOOP_TOKEN || '';
const BINDING = arg('binding', '');
const WORKSPACE = arg('workspace', '');
const ROOT = arg('path', '');

// Folders/files never worth reflecting (noise). Extend as needed.
const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', 'dist', '.next', '.cache', 'coverage', '.turbo']);
const MAX_FILE_BYTES = 25 * 1024 * 1024; // skip huge binaries — checksum cost + they're rarely "the work"

if (!TOKEN || !BINDING || !WORKSPACE || !ROOT) {
  console.error('Missing required input. Need: XLOOOP_TOKEN env + --binding + --workspace + --path');
  process.exit(2);
}

function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) { walk(full, acc); continue; }
    if (!e.isFile()) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    let checksum;
    try { checksum = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 32); } catch { continue; }
    acc.push({ path: relative(ROOT, full).split(sep).join('/'), checksum, size: st.size });
  }
  return acc;
}

const files = walk(ROOT, []);
console.log(`Scanned ${files.length} file(s) under ${ROOT}`);

const res = await fetch(`${API}/api/v1/folder-sources/sync`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ binding_id: BINDING, workspace_id: WORKSPACE, path: ROOT, files }),
});
if (!res.ok) {
  console.error(`sync failed: ${res.status} ${await res.text().catch(() => '')}`);
  process.exit(1);
}
const out = await res.json();
console.log(`Synced: ${out.emitted} event(s) filed · ${out.added} added · ${out.modified} changed · ${out.removed} removed`);
