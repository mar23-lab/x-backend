#!/usr/bin/env node
// verify-no-mbp-runtime-dependency.mjs · Decommission Wave D0 / OAR P2 closure (260713).
//
// LOCKS the runtime-independence invariant the OAR audit verified by hand: the deployed backend
// (src/workers/** + functions/**) contains ZERO references to the physical MB-P vault or any
// local-machine dependency class — the customer runtime must work with the /WIP/MB-P folder gone.
// Scanned dependency classes (mission Phase 7):
//   - local MB-P filesystem paths (/WIP/MB-P, ~/WIP/MB-P)
//   - local SQLite graph access (better-sqlite3, sqlite3, .db paths under MB-P)
//   - shell-outs to MB-P scripts (execSync/spawn with MB-P paths)
//   - launchd/local-hook references as runtime decisions
// Test files are excluded (they may assert the ABSENCE of these strings). Operator bridge PRODUCER
// scripts under scripts/ are out of scope by design (they run on the operator machine, not in the
// Worker — the boundary is the deployed runtime).
//
// Born GREEN (audit measured 0) and BLOCKING — this gate is class-A in the DELTA manifest, so the
// invariant rides the x-backend seed and holds there permanently.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_ROOTS = ['src/workers', 'functions'];

const PATTERNS = [
  { re: /\/WIP\/MB-P|~\/WIP\/MB-P/, label: 'physical MB-P path' },
  { re: /\bbetter-sqlite3\b|\bnode:sqlite\b|require\(['"]sqlite3['"]\)/, label: 'local SQLite access' },
  { re: /exec(?:File)?Sync?\([^)]*MB-P|spawn\([^)]*MB-P/, label: 'shell-out to MB-P script' },
  { re: /launchd|LaunchAgents/, label: 'launchd dependency' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue; // tests may assert ABSENCE
      yield* walk(p);
    } else if (/\.(ts|tsx|js|mjs|sql)$/.test(entry) && !/\.test\./.test(entry)) {
      yield p;
    }
  }
}

// self-test: prove each pattern bites on synthetic content
if (process.argv.includes('--self-test')) {
  const samples = [
    "const p = '/Users/x/WIP/MB-P/_sys/graph.json'",
    "import Database from 'better-sqlite3'",
    "execSync('python3 /WIP/MB-P/_sys/scripts/x.py')",
    'register with launchd for the refresh',
  ];
  let ok = true;
  for (let i = 0; i < PATTERNS.length; i++) {
    if (!PATTERNS[i].re.test(samples[i])) { console.error(`✗ self-test: pattern '${PATTERNS[i].label}' did not bite`); ok = false; }
  }
  if (!ok) process.exit(1);
  console.log('☑ self-test: all 4 dependency-class patterns bite');
  process.exit(0);
}

const hits = [];
for (const root of RUNTIME_ROOTS) {
  for (const file of walk(join(REPO, root))) {
    const src = readFileSync(file, 'utf-8');
    const lines = src.split('\n');
    for (const { re, label } of PATTERNS) {
      lines.forEach((line, i) => {
        if (re.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('--')) {
          hits.push(`${relative(REPO, file)}:${i + 1} [${label}] ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }
}

if (hits.length) {
  console.error(`✗ MB-P runtime dependencies found (${hits.length}) — the deployed backend must run with /WIP/MB-P gone:`);
  for (const h of hits.slice(0, 15)) console.error(`  ✗ ${h}`);
  process.exit(1);
}
console.log('☑ no-mbp-runtime-dependency holds · 0 physical MB-P / local-SQLite / shell-out / launchd refs in the deployed runtime');
