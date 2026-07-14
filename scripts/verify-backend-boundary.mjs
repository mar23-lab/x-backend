#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenRoots = ['src/app', 'src/runtime', 'src/widgets', 'src/pages', 'src/components', 'src/shared'];
const failures = [];

for (const rel of forbiddenRoots) {
  if (fs.existsSync(path.join(root, rel))) failures.push(`frontend root present: ${rel}`);
}

const importRe = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist-workers-dryrun') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(abs));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(abs);
  }
  return files;
}

for (const file of [...walk(path.join(root, 'src/workers')), ...walk(path.join(root, 'functions'))]) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(importRe)) {
    const specifier = match[1];
    if (/(?:^|\/)(?:app|runtime|widgets|pages|components|shared)(?:\/|$)/.test(specifier)) {
      failures.push(`${path.relative(root, file)} imports forbidden frontend path ${specifier}`);
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log('PASS backend boundary: no frontend roots and no runtime imports from frontend layers');
