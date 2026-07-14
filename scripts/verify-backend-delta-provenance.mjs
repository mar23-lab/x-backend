#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiptPath = path.join(root, 'MIGRATION-DELTA-PROVENANCE.json');
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
const failures = [];
const latestByPath = new Map();
const trackedPaths = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n'));
const seedExclusions = new Map();

function blobFor(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) return null;
  const content = fs.readFileSync(absolute);
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

if (receipt.schema_id !== 'xlooop.backend_delta_provenance.v1') {
  failures.push(`unexpected schema_id ${String(receipt.schema_id)}`);
}
if (!Array.isArray(receipt.deltas) || receipt.deltas.length === 0) {
  failures.push('at least one delta is required');
}

for (const delta of receipt.deltas ?? []) {
  if (!/^[0-9a-f]{40}$/.test(delta.source_commit ?? '')) {
    failures.push(`invalid source_commit for ${String(delta.delta_id)}`);
  }
  if (delta.authority !== 'shadow_only_no_production_cutover') {
    failures.push(`unsafe authority for ${String(delta.delta_id)}`);
  }
  for (const entry of delta.copied_files ?? []) {
    latestByPath.set(entry.path, { expected: entry.source_blob, mode: 'copied' });
  }
  for (const entry of delta.transformed_files ?? []) {
    latestByPath.set(entry.path, { expected: entry.target_blob, mode: 'transformed' });
  }
  for (const entry of delta.seed_exclusions ?? []) {
    seedExclusions.set(entry.path, entry);
  }
}

let copied = 0;
let transformed = 0;
for (const [relativePath, expectation] of latestByPath) {
  const actual = blobFor(relativePath);
  if (actual === null) {
    failures.push(`missing ${relativePath}`);
    continue;
  }
  if (actual !== expectation.expected) {
    failures.push(`${expectation.mode} blob drift ${relativePath}: ${expectation.expected} -> ${actual}`);
  }
  if (expectation.mode === 'copied') copied += 1;
  else transformed += 1;
}

for (const [relativePath, exclusion] of seedExclusions) {
  if (trackedPaths.has(relativePath)) failures.push(`seed exclusion became tracked: ${relativePath}`);
  if (!/^[0-9a-f]{40}$/.test(exclusion.source_blob ?? '')) {
    failures.push(`seed exclusion lacks its original source blob: ${relativePath}`);
  }
  if (!String(exclusion.reason ?? '').trim()) failures.push(`seed exclusion lacks a reason: ${relativePath}`);
}

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  process.exit(1);
}
console.log(`PASS delta provenance: ${receipt.deltas.length} delta(s), ${copied} exact copied blobs, ${transformed} target-managed blobs, ${seedExclusions.size} governed seed exclusion(s)`);
