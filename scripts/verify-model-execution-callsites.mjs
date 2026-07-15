#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/model-execution-callsite-manifest.json'), 'utf8'));
const errors = [];
const callableFunctions = ['answerCockpitChat', 'buildWorkspaceDigestLLM', 'buildOnboardingWelcomeDraft', 'refinePromptText', 'generateIntentEnrichment'];

if (manifest.schema_version !== 'xlooop.model_execution_callsites.v1') errors.push('unexpected schema_version');
if (!Array.isArray(manifest.callsites) || manifest.callsites.length === 0) errors.push('callsites must be a non-empty array');

const expectedCounts = new Map();
for (const entry of manifest.callsites ?? []) {
  for (const field of ['id', 'path', 'function', 'anchor', 'observer_token', 'principal', 'action']) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) errors.push(`${entry.id ?? 'unknown'}: missing ${field}`);
  }
  const absolute = path.join(root, entry.path);
  if (!fs.existsSync(absolute)) {
    errors.push(`${entry.id}: missing file ${entry.path}`);
    continue;
  }
  const source = fs.readFileSync(absolute, 'utf8');
  const occurrence = Number(entry.anchor_occurrence ?? 1);
  let index = -1;
  for (let i = 0; i < occurrence; i += 1) index = source.indexOf(entry.anchor, index + 1);
  if (index < 0) {
    errors.push(`${entry.id}: anchor occurrence ${occurrence} missing`);
    continue;
  }
  const callWindow = source.slice(index, index + 2400);
  if (!callWindow.includes(entry.observer_token)) errors.push(`${entry.id}: observer token is not adjacent to call`);
  const key = `${entry.path}::${entry.function}`;
  expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
}

const actualCounts = new Map();
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, item.name);
    if (item.isDirectory()) walk(absolute);
    else if (item.isFile() && item.name.endsWith('.ts') && !absolute.includes(`${path.sep}__tests__${path.sep}`)) {
      const relative = path.relative(root, absolute);
      const source = fs.readFileSync(absolute, 'utf8');
      for (const fn of callableFunctions) {
        const matches = source.match(new RegExp(`\\b${fn}\\s*\\(`, 'g')) ?? [];
        const declarations = source.match(new RegExp(`(?:function|interface|type)\\s+${fn}\\b`, 'g')) ?? [];
        const count = matches.length - declarations.length;
        if (count > 0) actualCounts.set(`${relative}::${fn}`, count);
      }
    }
  }
}
walk(path.join(root, 'src/workers'));

for (const key of new Set([...expectedCounts.keys(), ...actualCounts.keys()])) {
  const expected = expectedCounts.get(key) ?? 0;
  const actual = actualCounts.get(key) ?? 0;
  if (expected !== actual) errors.push(`${key}: manifest=${expected}, source=${actual}`);
}

const actualTotal = [...actualCounts.values()].reduce((sum, value) => sum + value, 0);
const coverage = actualTotal === 0 ? 0 : (manifest.callsites.length / actualTotal) * 100;
if (errors.length > 0) {
  console.error(JSON.stringify({ status: 'fail', errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  status: 'pass',
  callsite_count: manifest.callsites.length,
  model_execution_callsite_coverage_pct: Number(coverage.toFixed(2)),
  strict_flag: manifest.strict_flag,
}, null, 2));
