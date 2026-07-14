#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receipt = JSON.parse(fs.readFileSync(path.join(root, 'MIGRATION-PROVENANCE.json'), 'utf8'));
const failures = [];
for (const entry of receipt.files) {
  const absolute = path.join(root, entry.path);
  if (!fs.existsSync(absolute)) {
    failures.push(`missing ${entry.path}`);
    continue;
  }
  const content = fs.readFileSync(absolute);
  const blob = crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  if (blob !== entry.source_blob) failures.push(`blob drift ${entry.path}: ${entry.source_blob} -> ${blob}`);
}
if (failures.length) {
  for (const failure of failures.slice(0, 30)) console.error(`FAIL ${failure}`);
  if (failures.length > 30) console.error(`... ${failures.length - 30} more`);
  process.exit(1);
}
console.log(`PASS provenance: ${receipt.files.length}/${receipt.files.length} copied blobs match ${receipt.source_commit.slice(0, 12)}`);
