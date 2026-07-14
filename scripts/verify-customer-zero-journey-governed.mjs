#!/usr/bin/env node
/*
 * verify-customer-zero-journey-governed
 * ------------------------------------------------------------------------
 * Asserts the customer-zero journey (a customer's FIRST end-to-end use of the
 * cockpit, captured by `scripts/capture-customer-zero-session.mjs` into the
 * committed receipt) is a fully GOVERNED, AUDIT-BACKED chain — and is honest
 * about NOT executing / NOT over-claiming. This is the Track-A (product) mirror
 * of the Track-B (MB-P) governance ladder: the cockpit must demonstrably emit
 * intent -> packet -> event -> evidence -> sign-off for a real journey, with
 * every claim gated behind its evidence and every link observable in the stream.
 *
 * Four invariant classes (each backed by a committed in-repo fixture — no network,
 * deterministic, offline-safe):
 *   A. CHAIN COMPLETENESS — the full governed lineage is present + non-empty
 *      (goal -> intent -> packet -> event[] -> decision -> evidence[] -> sign-off -> metric).
 *   B. GOVERNED-NOT-EXECUTED — the journey did NOT mutate product state and is
 *      tagged learning-evidence-only (mirrors the inert ops-queue executor:
 *      governed evidence, not a live execution).
 *   C. CLAIM-GATING (implication, future-proof) — a claim may be allowed ONLY if
 *      its evidence gate is satisfied: claim_allowed => evidence_satisfied. A
 *      receipt that flips a claim to true WITHOUT the strict receipt is an
 *      ungoverned over-claim and is REJECTED.
 *   D. AUDIT-BACKED — the receipt's claimed event count matches the ACTUAL
 *      committed operations-live-stream fixture (the chain is real, not asserted),
 *      is internally consistent, and the stream push is receipted PASS.
 *
 * Run `--self-test` to prove the checks bite (a regressed receipt is caught; the
 * valid shape passes). Exit 0 = PASS, 1 = FAIL. Wired BLOCKING in ci-local.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const RECEIPT_PATH = 'docs/deployment/evidence/customer-zero/latest-customer-zero-session-receipt.json';
const STREAM_PATH = 'data/operations-live-stream.json';

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));

// Count the rows in the committed operations-live-stream fixture (the audit source).
function streamRowCount(stream) {
  const rows = stream && (stream.rows || stream.events || stream.stream);
  return Array.isArray(rows) ? rows.length : null;
}

const isNonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;

/*
 * Pure validator — returns failures[]. Takes the receipt + the actual stream row
 * count so the self-test can drive it with synthetic inputs.
 */
export function validateGovernedJourney(receipt, actualStreamRows) {
  const failures = [];
  const fail = (id, detail) => failures.push({ id, detail });
  const cf = (receipt && receipt.canonical_flow) || {};
  const os = (receipt && receipt.observed_state) || {};

  // ---- A. CHAIN COMPLETENESS ----
  if (receipt?.schema_version !== 'xlooop.customer_zero_session_receipt.v1') {
    fail('schema_version', `expected xlooop.customer_zero_session_receipt.v1, got ${receipt?.schema_version}`);
  }
  for (const link of ['goal_ref', 'intent_ref', 'decision_ref', 'signoff_ref', 'metric_ref']) {
    if (!isNonEmptyStr(cf[link])) fail(`chain:${link}`, `governed-chain link '${link}' missing/empty`);
  }
  if (!isNonEmptyStr(cf.packet_ref) || !/^customer-zero:/.test(cf.packet_ref)) {
    fail('chain:packet_ref', `packet_ref must be a non-empty 'customer-zero:*' id, got ${cf.packet_ref}`);
  }
  if (!Array.isArray(cf.event_refs) || cf.event_refs.length === 0) {
    fail('chain:event_refs', 'event_refs[] must be a non-empty array (events emitted)');
  }
  if (!Array.isArray(cf.evidence_refs) || cf.evidence_refs.length === 0) {
    fail('chain:evidence_refs', 'evidence_refs[] must be a non-empty array (evidence attached)');
  }

  // ---- B. GOVERNED-NOT-EXECUTED ----
  if (receipt?.mutates_product_state !== false) {
    fail('no_execution:mutates_product_state', 'a customer-zero journey must NOT mutate product state (mutates_product_state !== false)');
  }
  if (receipt?.status !== 'learning_evidence_only') {
    fail('no_execution:status', `expected status 'learning_evidence_only' (governed evidence, not live execution), got ${receipt?.status}`);
  }

  // ---- C. CLAIM-GATING (implication: claim_allowed => evidence_satisfied) ----
  // A production-SaaS or private-operator claim is permissible ONLY when the strict
  // paid-pilot evidence gate is satisfied. Flipping a claim true without it = over-claim.
  const strictOk = receipt?.strict_paid_pilot_satisfies === true;
  if (receipt?.production_saas_claim_allowed === true && !strictOk) {
    fail('claim_gating:production_saas', 'production_saas_claim_allowed=true requires strict_paid_pilot_satisfies=true (ungoverned over-claim)');
  }
  if (receipt?.private_operator_claim_allowed === true && !strictOk) {
    fail('claim_gating:private_operator', 'private_operator_claim_allowed=true requires strict_paid_pilot_satisfies=true (ungoverned over-claim)');
  }
  // The sign-off must be an explicit decision, not absent. A gated journey carries a
  // blocked/pending sign-off; a satisfied one carries a positive ref. Either is fine —
  // what's forbidden is claims-true with a still-blocked sign-off (caught above) or no ref.
  if (!isNonEmptyStr(cf.signoff_ref)) {
    fail('claim_gating:signoff_present', 'signoff_ref must record an explicit governance decision');
  }

  // ---- D. AUDIT-BACKED ----
  const claimedRows = os.operations_live_stream_rows;
  if (typeof claimedRows !== 'number') {
    fail('audit:rows_type', 'observed_state.operations_live_stream_rows must be a number');
  } else if (actualStreamRows !== null && claimedRows !== actualStreamRows) {
    fail('audit:rows_match', `receipt claims ${claimedRows} live-stream rows but the committed fixture has ${actualStreamRows} (chain not audit-backed)`);
  }
  if (typeof os.operations_live_stream_push_rows === 'number' && os.operations_live_stream_push_rows !== claimedRows) {
    fail('audit:rows_internal', `operations_live_stream_rows (${claimedRows}) !== operations_live_stream_push_rows (${os.operations_live_stream_push_rows})`);
  }
  if (os.operations_live_stream_push_receipt_status !== 'PASS') {
    fail('audit:push_receipt', `the live-stream push must be receipted PASS, got ${os.operations_live_stream_push_receipt_status}`);
  }

  return failures;
}

// ----------------------------- self-test -----------------------------
function selfTest() {
  // A minimal VALID receipt (the governed, honest, audit-backed shape) -> 0 failures.
  const valid = {
    schema_version: 'xlooop.customer_zero_session_receipt.v1',
    status: 'learning_evidence_only',
    mutates_product_state: false,
    strict_paid_pilot_satisfies: false,
    production_saas_claim_allowed: false,
    private_operator_claim_allowed: false,
    canonical_flow: {
      goal_ref: 'g', intent_ref: 'i', packet_ref: 'customer-zero:2026-06-13T04-05-13-586Z',
      event_refs: ['e1'], decision_ref: 'd', evidence_refs: ['ev1'], signoff_ref: 'blocked_until_strict', metric_ref: 'm',
    },
    observed_state: { operations_live_stream_rows: 55, operations_live_stream_push_rows: 55, operations_live_stream_push_receipt_status: 'PASS' },
  };
  const greenOk = validateGovernedJourney(valid, 55).length === 0;

  // RED cases — each MUST produce >=1 failure (the checks bite).
  const red = [
    ['incomplete_chain', { ...valid, canonical_flow: { ...valid.canonical_flow, intent_ref: '' } }, 55],
    ['mutated_state', { ...valid, mutates_product_state: true }, 55],
    ['over_claim', { ...valid, production_saas_claim_allowed: true /* strict still false */ }, 55],
    ['not_audit_backed', { ...valid }, 99 /* fixture has a different count than the claimed 55 */],
    ['unreceipted_push', { ...valid, observed_state: { ...valid.observed_state, operations_live_stream_push_receipt_status: 'FAIL' } }, 55],
  ];
  const redResults = red.map(([name, r, n]) => [name, validateGovernedJourney(r, n).length > 0]);
  const redAllBite = redResults.every(([, bit]) => bit);

  // A LEGITIMATE strict-pass receipt with claims=true MUST still pass (implication, not hardcode).
  const strictPass = { ...valid, strict_paid_pilot_satisfies: true, production_saas_claim_allowed: true, private_operator_claim_allowed: true };
  const strictOk = validateGovernedJourney(strictPass, 55).length === 0;

  if (greenOk && redAllBite && strictOk) {
    console.log(`PASS self-test · valid receipt passes; all ${red.length} regressions caught (${redResults.map(([n]) => n).join(', ')}); strict-pass-with-claims allowed (implication)`);
    process.exit(0);
  }
  console.error(`FAIL self-test · greenOk=${greenOk} strictOk=${strictOk} reds=${JSON.stringify(redResults)}`);
  process.exit(1);
}

// ------------------------------- main --------------------------------
function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  let receipt, stream;
  try { receipt = readJson(RECEIPT_PATH); }
  catch (e) { console.error(`✗ verify:customer-zero-journey-governed · cannot read ${RECEIPT_PATH}: ${e.message}`); process.exit(1); }
  try { stream = readJson(STREAM_PATH); }
  catch (e) { console.error(`✗ verify:customer-zero-journey-governed · cannot read ${STREAM_PATH}: ${e.message}`); process.exit(1); }

  const actualRows = streamRowCount(stream);
  const failures = validateGovernedJourney(receipt, actualRows);

  const summary = {
    status: failures.length ? 'FAIL' : 'PASS',
    receipt_generated_at: receipt.generated_at,
    workspace: receipt.scope?.workspace_id,
    project: receipt.scope?.project_id,
    chain_complete: !failures.some((f) => f.id.startsWith('chain:')),
    governed_not_executed: !failures.some((f) => f.id.startsWith('no_execution:')),
    claims_gated: !failures.some((f) => f.id.startsWith('claim_gating:')),
    audit_backed: !failures.some((f) => f.id.startsWith('audit:')),
    stream_rows: actualRows,
    failures,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (failures.length) {
    console.error(`✗ verify:customer-zero-journey-governed · ${failures.length} invariant(s) violated`);
    process.exit(1);
  }
  console.log('☑ verify:customer-zero-journey-governed · PASS · governed chain complete + not-executed + claims gated + audit-backed');
  process.exit(0);
}

// Run only when invoked directly (so the module stays importable for reuse/testing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
