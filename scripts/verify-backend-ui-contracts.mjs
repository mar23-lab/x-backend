#!/usr/bin/env node
// scripts/verify-backend-ui-contracts.mjs
//
// OPERATOR-STABILITY-1 (260602) · Backend-to-UI data contract gate.
//
// WHY: The backend-data-contract-map.md audit identified 7 entities missing
// frontend TypeScript contracts. Phase 2 created 4 of them. This gate verifies:
//   1. The 4 new contracts exist at expected paths
//   2. Each exports the expected minimum interface names
//   3. They are exported from contracts/index.ts (barrel export)
//   4. The runtime TypeScript types (src/runtime/types.d.ts) still cover
//      the operations-live-stream view type with valid_until field
//
// Exit: 0 = PASS, 1 = FAIL.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ☑ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

console.log('verify-backend-ui-contracts · OPERATOR-STABILITY-1\n');

const CONTRACTS = [
  {
    name: 'Recommendation contract',
    path: 'src/contracts/recommendation/recommendation.contract.ts',
    requiredExports: ['Recommendation', 'RecommendationStatus', 'UseRecommendationsResult', 'isLemV4Recommendation'],
  },
  {
    name: 'Workspace contract',
    path: 'src/contracts/workspace/workspace.contract.ts',
    requiredExports: ['Workspace', 'WorkspaceConfig', 'WorkspaceOrigin', 'isNativeWorkspace'],
  },
  {
    name: 'Project contract',
    path: 'src/contracts/project/project.contract.ts',
    requiredExports: ['Project', 'ProjectEvent', 'UseProjectEventsResult', 'ProjectStatus'],
  },
  {
    name: 'EnrichedStream contract',
    path: 'src/contracts/operations-live-stream/enriched-stream.contract.ts',
    requiredExports: ['EnrichedStreamRow', 'EnrichedStream', 'isLiveApiRow', 'hasLiveRows'],
  },
];

const indexPath = path.join(REPO_ROOT, 'src/contracts/index.ts');
const indexSrc = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';

for (const contract of CONTRACTS) {
  const fullPath = path.join(REPO_ROOT, contract.path);
  check(`${contract.name}: file exists`, existsSync(fullPath), contract.path);

  if (existsSync(fullPath)) {
    const src = readFileSync(fullPath, 'utf8');
    for (const exp of contract.requiredExports) {
      check(
        `${contract.name}: exports ${exp}`,
        src.includes(exp),
        `expected '${exp}' in ${contract.path}`,
      );
    }
  }

  const importFragment = contract.path.replace('src/contracts/', './').replace('.ts', '');
  check(
    `${contract.name}: barrel-exported from contracts/index.ts`,
    indexSrc.includes(importFragment) || indexSrc.includes(contract.path.split('/').slice(-1)[0].replace('.ts', '')),
    `expected import of ${importFragment} in index.ts`,
  );
}

// Verify the runtime types still have valid_until (S2 fix regression guard)
const runtimeTypesPath = path.join(REPO_ROOT, 'src/runtime/types.d.ts');
if (existsSync(runtimeTypesPath)) {
  const rtSrc = readFileSync(runtimeTypesPath, 'utf8');
  check(
    'XcpOperationsLiveStreamView: valid_until field present',
    rtSrc.includes('valid_until'),
    'expected valid_until in XcpOperationsLiveStreamView (S2 fix regression guard)',
  );
  check(
    'XcpOperationsLiveStreamView: source_mode field present',
    rtSrc.includes('source_mode'),
    'expected source_mode in XcpOperationsLiveStreamView',
  );
}

console.log(`\nverify-backend-ui-contracts · ${failed === 0 ? 'PASS' : 'FAIL'} · ${passed}/${passed + failed} passed`);

if (failed > 0) {
  console.error(`\n${failed} failure(s). Phase 2 data contracts are missing or incomplete.`);
  process.exit(1);
}
process.exit(0);
