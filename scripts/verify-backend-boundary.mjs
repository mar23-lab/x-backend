#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenRoots = ['src/app', 'src/runtime', 'src/widgets', 'src/pages', 'src/components', 'src/shared'];
const failures = [];
const selfTest = process.argv.includes('--self-test');

function validateEntryContracts(agentContract, claudeContract) {
  const entryFailures = [];
  for (const marker of [
    '`x-backend` is the production API source authority',
    '`merged`,',
    '`deployed`,',
    '`authoritative`',
    '`Xlooop-XCP-demo` is',
    'donor-only',
    'numeric `schema_head`',
    'exact 40-character build SHA',
    'Never bypass `npm run deploy:api`',
    'isolated `codex/*` or `claude/*` worktree',
  ]) {
    if (!agentContract.includes(marker)) entryFailures.push(`AGENTS.md lost authority marker: ${marker}`);
  }
  for (const marker of [
    'production API source authority',
    'Deployed provenance remains independent',
    'Never bypass `npm run deploy:api`',
    '`Xlooop-XCP-demo` as donor-only',
  ]) {
    if (!claudeContract.includes(marker)) entryFailures.push(`CLAUDE.md lost authority marker: ${marker}`);
  }
  for (const [label, pattern] of [
    ['shadow-only repository claim', /A \*\*SHADOW backend\*\*/i],
    ['never-deploy repository claim', /\*\*SHADOW REPO — never deploy/i],
    ['demo deployment authority claim', /Xlooop-XCP-demo is the current deployed authority/i],
    ['shadow-until-cutover claim', /repository is a shadow backend until/i],
  ]) {
    if (pattern.test(`${agentContract}\n${claudeContract}`)) {
      entryFailures.push(`agent entry contract contains stale ${label}`);
    }
  }
  return entryFailures;
}

if (selfTest) {
  const staleAgent = [
    'A **SHADOW backend** that is not live.',
    '**SHADOW REPO — never deploy.**',
    'Xlooop-XCP-demo is the current deployed authority.',
  ].join('\n');
  const staleClaude = 'This repository is a shadow backend until an explicitly approved cutover.';
  const entryFailures = validateEntryContracts(staleAgent, staleClaude);
  const expected = [
    'agent entry contract contains stale shadow-only repository claim',
    'agent entry contract contains stale never-deploy repository claim',
    'agent entry contract contains stale demo deployment authority claim',
    'agent entry contract contains stale shadow-until-cutover claim',
  ];
  if (expected.every((failure) => entryFailures.includes(failure))) {
    console.log('SELF-TEST PASS backend boundary rejects stale shadow-only authority entry contracts');
    process.exit(0);
  }
  for (const failure of expected.filter((failure) => !entryFailures.includes(failure))) {
    console.error(`FAIL missing expected self-test failure: ${failure}`);
  }
  process.exit(1);
}

failures.push(...validateEntryContracts(
  fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
  fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'),
));

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
