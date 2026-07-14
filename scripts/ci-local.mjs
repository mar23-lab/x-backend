#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const gates = [
  ['provenance', 'npm', ['run', 'verify:provenance']],
  ['boundary', 'npm', ['run', 'verify:boundary']],
  ['runtime independence', 'npm', ['run', 'verify:no-mbp-runtime-dependency']],
  ['API contract', 'npm', ['run', 'verify:contract']],
  ['packet completion contract', 'npm', ['run', 'verify:packet-completion-contract']],
  ['typed work relationships', 'npm', ['run', 'verify:typed-work-relationships']],
  ['action intent shadow', 'npm', ['run', 'verify:action-intent-shadow']],
  ['data schemas', 'npm', ['run', 'verify:data-schemas']],
  ['orphan tests', 'npm', ['run', 'verify:no-orphan-worker-tests']],
  ['typecheck', 'npm', ['run', 'typecheck']],
  ['worker suite', 'npm', ['test']],
];

let failed = 0;
for (const [name, command, args] of gates) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAIL ${name} (exit ${String(result.status)})`);
    break;
  }
}

if (failed) process.exit(1);
console.log(`\nPASS x-backend local authority stack (${gates.length}/${gates.length})`);
