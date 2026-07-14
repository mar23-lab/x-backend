#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receipt = JSON.parse(fs.readFileSync(path.join(root, 'MIGRATION-PROVENANCE.json'), 'utf8'));
const deltaPath = path.join(root, 'MIGRATION-DELTA-PROVENANCE.json');
const deltaReceipt = fs.existsSync(deltaPath)
  ? JSON.parse(fs.readFileSync(deltaPath, 'utf8'))
  : { deltas: [] };
const supersededPaths = new Set(
  (deltaReceipt.deltas ?? []).flatMap((delta) => [
    ...(delta.copied_files ?? []).map((entry) => entry.path),
    ...(delta.transformed_files ?? []).map((entry) => entry.path),
    ...(delta.seed_exclusions ?? []).map((entry) => entry.path),
  ]),
);
const failures = [];
let checked = 0;
for (const entry of receipt.files) {
  if (supersededPaths.has(entry.path)) continue;
  const absolute = path.join(root, entry.path);
  if (!fs.existsSync(absolute)) {
    failures.push(`missing ${entry.path}`);
    continue;
  }
  const content = fs.readFileSync(absolute);
  const blob = crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  if (blob !== entry.source_blob) failures.push(`blob drift ${entry.path}: ${entry.source_blob} -> ${blob}`);
  checked += 1;
}
if (failures.length) {
  for (const failure of failures.slice(0, 30)) console.error(`FAIL ${failure}`);
  if (failures.length > 30) console.error(`... ${failures.length - 30} more`);
  process.exit(1);
}
console.log(`PASS seed provenance: ${checked} unchanged blobs match ${receipt.source_commit.slice(0, 12)}; ${receipt.files.length - checked} seed paths delegated (${supersededPaths.size} total delta-managed paths)`);
