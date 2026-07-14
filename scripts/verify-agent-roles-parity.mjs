#!/usr/bin/env node
// scripts/verify-agent-roles-parity.mjs
//
// S2 (OS-4 roles/skills contract, 2026-06-12) · the agent-identity parity gate. Same class as
// verify-capture-field-parity: a STATIC chain check between the declarative registry
// (docs/contracts/agent-roles.yml) and the executor source, so the registry can never silently
// drift from the code it describes.
//
//   (a) every `*_AGENT_ID = '<id>'` constant in operations-queue-consumer.ts has a registry entry
//       — no unregistered automation identity ever stamps operation_events rows;
//   (b) registry `executor_verbs` === the VERB_HANDLERS keys (BOTH directions: a claimed verb
//       that does not exist is drift; a new verb must be claimed in the same PR).
//
// Self-test on every run (a dead extractor must not green-light a clean scan).
// Exit 0 = parity holds. Exit 1 = drift.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'docs/contracts/agent-roles.yml';
const CONSUMER = 'src/workers/services/operations-queue-consumer.ts';
// OAR-W0 F5 (260713): the original scan covered ONLY the executor consumer, so an agent-id constant
// declared anywhere else (the review-scheduler cron shipped 'agent_review_scheduler' unregistered)
// was invisible to the gate. AGENT_ID constants are now collected from EVERY .ts file under these
// roots; the VERB_HANDLERS parity remains consumer-scoped (that registry lives only there).
const AGENT_ID_SCAN_ROOTS = ['src/workers/services', 'src/workers/crons', 'src/workers/routes', 'src/workers/lib'];

function tsFilesUnder(rel) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
    }
  };
  const abs = path.join(repoRoot, rel);
  if (fs.existsSync(abs)) walk(abs);
  return out.sort();
}

// ── extractors ────────────────────────────────────────────────────────────────────────────────
export function extractAgentIdConstants(src) {
  // const DIGEST_AGENT_ID = 'xlooop:digest-agent';
  return [...src.matchAll(/^const \w*AGENT_ID = '([^']+)';/gm)].map((m) => m[1]);
}

export function extractVerbHandlerKeys(src) {
  // keys of the frozen VERB_HANDLERS object literal: `  digest: async (`
  const block = src.match(/const VERB_HANDLERS[\s\S]*?^\}\);/m);
  if (!block) return [];
  return [...block[0].matchAll(/^  ([a-z][\w-]*): async /gm)].map((m) => m[1]);
}

export function extractRegistryAgents(src) {
  // constrained-YAML: agent entries are `  "<id>":` two-space-indented quoted keys under agents:
  return [...src.matchAll(/^  "([^"]+)":\s*$/gm)].map((m) => m[1]);
}

export function extractRegistryExecutorVerbs(src) {
  // every `executor_verbs: [a, b]` list, flattened
  return [...src.matchAll(/^\s*executor_verbs:\s*\[([^\]]*)\]/gm)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
}

// ── self-test (every run) ─────────────────────────────────────────────────────────────────────
function selfTest(verbose) {
  const idsOk = extractAgentIdConstants("const X_AGENT_ID = 'xlooop:x';\nconst notAnId = 'y';").join() === 'xlooop:x';
  const verbsOk = extractVerbHandlerKeys('const VERB_HANDLERS: R = Object.freeze({\n  digest: async (e) => {},\n  plan: async (e) => {},\n});').join() === 'digest,plan';
  const agentsOk = extractRegistryAgents('agents:\n  "xlooop:a":\n    role: executor\n  "xlooop:b":\n').join() === 'xlooop:a,xlooop:b';
  const claimOk = extractRegistryExecutorVerbs('    executor_verbs: [digest, plan]\n').join() === 'digest,plan';
  const pass = idsOk && verbsOk && agentsOk && claimOk;
  if (verbose || !pass) {
    console.log('agent-roles-parity · self-test');
    for (const [ok, label] of [[idsOk, 'AGENT_ID extractor'], [verbsOk, 'VERB_HANDLERS extractor'], [agentsOk, 'registry-agent extractor'], [claimOk, 'executor_verbs extractor']]) {
      console.log(`  ${ok ? '☑' : '✗'} ${label} bites`);
    }
  }
  return pass;
}

if (process.argv.includes('--self-test')) process.exit(selfTest(true) ? 0 : 1);
if (!selfTest(false)) {
  console.error('✗ agent-roles-parity self-test FAILED — extractors are dead; refusing to report a clean scan.');
  process.exit(1);
}

// ── parity ────────────────────────────────────────────────────────────────────────────────────
const registrySrc = fs.readFileSync(path.join(repoRoot, REGISTRY), 'utf8');
const consumerSrc = fs.readFileSync(path.join(repoRoot, CONSUMER), 'utf8');

// AGENT_ID constants: collected repo-wide across the scan roots (F5 widening), tagged with their file.
const constantSites = AGENT_ID_SCAN_ROOTS.flatMap((root) =>
  tsFilesUnder(root).flatMap((abs) => {
    const rel = path.relative(repoRoot, abs);
    return extractAgentIdConstants(fs.readFileSync(abs, 'utf8')).map((id) => ({ id, file: rel }));
  }),
);
const constants = [...new Set(constantSites.map((s) => s.id))];
const handlerVerbs = extractVerbHandlerKeys(consumerSrc);
const registryAgents = extractRegistryAgents(registrySrc);
const claimedVerbs = extractRegistryExecutorVerbs(registrySrc);

const failures = [];
for (const { id, file } of constantSites) {
  if (!registryAgents.includes(id)) {
    failures.push(`unregistered agent identity: ${file} stamps '${id}' but ${REGISTRY} has no entry for it`);
  }
}
for (const v of claimedVerbs) {
  if (!handlerVerbs.includes(v)) {
    failures.push(`phantom verb claim: ${REGISTRY} claims executor verb '${v}' but VERB_HANDLERS has no such handler`);
  }
}
for (const v of handlerVerbs) {
  if (!claimedVerbs.includes(v)) {
    failures.push(`unclaimed verb: VERB_HANDLERS runs '${v}' but no agent in ${REGISTRY} claims it (add it to executor_verbs in the same PR)`);
  }
}

console.log('agent-roles-parity · registry <-> executor source');
console.log('─'.repeat(72));
console.log(`  agents declared: ${registryAgents.length} · AGENT_ID constants: ${constants.length} · verbs: handlers=${handlerVerbs.join(',') || '(none)'} claimed=${claimedVerbs.join(',') || '(none)'}`);
if (failures.length) {
  console.error('✗ agent-roles parity DRIFT:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('☑ agent-roles parity holds · every automation identity registered, verbs fully claimed');
process.exit(0);
