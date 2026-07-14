#!/usr/bin/env node
// S7 (2026-06-28) · verify:context-reaches-consumer — the WRITE-ONLY-SILO detector.
//
// Part Q root cause: the readiness onboarding captured rich company context into
// `readiness_assessments`, but that row was READ by nothing except the one-time
// roadmap build — a write-only silo. The product asked the customer 5 questions,
// drew a radar implying it understood, then ignored the answers. S1 wired the
// captured context to the AI consumers (the MCP get_effective_profile envelope, the
// cockpit chat, the cockpit-chat system prompt). This gate makes that wiring
// PERMANENT: for each captured context surface it asserts a READER reference exists
// in EVERY declared consumer. A future refactor that deletes the read while keeping
// the write (re-siloing the context) fails loudly here instead of silently shipping
// a product that ignores what it captured.
//
// Static guard over the producer + the declared consumers (no build/runtime needed)
// — same style + inline self-test as scripts/verify-data-source-truth.mjs.
//
// The generalizable pillar (DDD): CAPTURE IMPLIES CONSUMPTION. A write without a
// read is a silo defect. To extend coverage to a new captured surface, add a row to
// MANIFEST below — no new gate needed.
//
// Run: node scripts/verify-context-reaches-consumer.mjs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  try { return readFileSync(resolve(REPO_ROOT, rel), 'utf8'); }
  catch (_) { return null; }
}

// Strip line + block comments so prose mentioning a marker can't false-satisfy a
// reader assertion (a comment that says "we used to call getCustomerContextProfile"
// must NOT count as a live reader).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

// The capture→consumer manifest. Each captured surface MUST have its projection +
// getter + the seam (the workspace_id stamp), AND a reader reference in EVERY
// declared consumer. `needle`/`needles` are the exact live-code markers; if a
// refactor drops one (re-siloing the write), the gate fails with a precise message.
const MANIFEST = [
  {
    capture: 'readiness_assessments (onboarding company context)',
    projection: { file: 'src/workers/dal/customer-context-store.ts', needles: ['export function buildCustomerContextProfile'] },
    getter: { file: 'src/workers/dal/customer-context-store.ts', needles: ['export async function getCustomerContextProfileRow'] },
    // The seam that makes the captured context recoverable BY WORKSPACE (the
    // consumers only hold a workspace_id). Without this UPDATE the column stays NULL
    // and even a willing reader can't find the context — the silo's other end.
    stamp: { file: 'src/workers/dal/customer-provisioning-store.ts', needles: ['UPDATE readiness_assessments SET workspace_id'] },
    consumers: [
      { name: 'MCP get_effective_profile envelope (the connected Claude Code / Codex / Cursor)', file: 'src/workers/routes/template-policy-registry.ts', needles: ['getCustomerContextProfile', 'company_context'] },
      { name: 'in-app cockpit chat fetch (the scoped operator chat)', file: 'src/workers/routes/workspaces.ts', needles: ['getCustomerContextProfile'] },
      { name: 'cockpit-chat system prompt (company-aware preamble)', file: 'src/workers/services/cockpit-chat.ts', needles: ['companyContextPreamble'] },
    ],
  },
];

// Returns the reader probe used both by the live check and the self-test: does
// `src` (comment-stripped) contain ALL the needles?
function readerPresent(src, needles) {
  const stripped = stripComments(src);
  return needles.every((n) => stripped.includes(n));
}

const failures = [];

for (const m of MANIFEST) {
  // The projection + getter + stamp must exist (the single source the consumers read,
  // and the seam that makes it findable).
  for (const part of ['projection', 'getter', 'stamp']) {
    const spec = m[part];
    const src = read(spec.file);
    if (src == null) { failures.push(`[${m.capture}] ${part}: file missing — ${spec.file}`); continue; }
    if (!readerPresent(src, spec.needles)) {
      failures.push(`[${m.capture}] ${part}: marker missing in ${spec.file} — ${spec.needles.join(' + ')}`);
    }
  }
  // Each declared consumer must carry a reader reference (else the write is silo'd).
  for (const c of m.consumers) {
    const src = read(c.file);
    if (src == null) { failures.push(`[${m.capture}] consumer "${c.name}": file missing — ${c.file}`); continue; }
    if (!readerPresent(src, c.needles)) {
      failures.push(`[${m.capture}] consumer "${c.name}": ${c.file} no longer reads the captured context (missing: ${c.needles.join(' + ')}) — WRITE-ONLY-SILO regression: the onboarding context would be captured but ignored by this consumer.`);
    }
  }
}

// SELF-TEST — prove the silo detector BITES. A consumer source that dropped the
// reader MUST be flagged; a source that has it MUST pass. If either expectation is
// wrong the probe is broken and the gate is worthless, so fail loudly.
{
  const wired = "const cc = await dal.getCustomerContextProfile(id); return ctx.json({ profile, company_context: cc });";
  const siloed = "// getCustomerContextProfile used to be read here\n return ctx.json({ profile });"; // the regression: reader deleted, only a comment remains
  if (!readerPresent(wired, ['getCustomerContextProfile', 'company_context'])) {
    failures.push('self-test: reader probe FAILED on a wired consumer (assertion does not bite)');
  }
  if (readerPresent(siloed, ['getCustomerContextProfile', 'company_context'])) {
    failures.push('self-test: reader probe false-positived on a silo (counted a COMMENT as a live reader — comment-stripping broken)');
  }
}

if (failures.length) {
  console.error('✗ verify:context-reaches-consumer · captured onboarding context is SILO\'d (a write without a read)');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log('☑ verify:context-reaches-consumer · every captured onboarding surface reaches its AI consumers');
console.log('  readiness_assessments → buildCustomerContextProfile/getCustomerContextProfileRow (+ workspace_id stamp)');
console.log('  → consumers: MCP get_effective_profile · cockpit chat fetch · cockpit-chat preamble · (self-test passed)');
