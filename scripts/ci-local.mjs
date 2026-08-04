#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const gates = [
  ['github actions disabled', 'npm', ['run', 'verify:github-actions-disabled']],
  ['installed dependency parity', 'npm', ['run', 'verify:installed-dependencies']],
  ['known dependency advisory floors', 'npm', ['run', 'verify:known-dependency-advisories']],
  ['MCP server typecheck', 'npm', ['--prefix', 'packages/xlooop-mcp-server', 'run', 'typecheck']],
  ['MCP server build', 'npm', ['--prefix', 'packages/xlooop-mcp-server', 'run', 'build']],
  ['MCP server tests', 'npm', ['--prefix', 'packages/xlooop-mcp-server', 'test']],
  ['provenance', 'npm', ['run', 'verify:provenance']],
  // Two ratchets, both monotonic. They exist because the estate measured which numbers actually
  // predicted its failures: 1,577 green unit tests coexisted with every customer-facing outage,
  // while "gates proven able to fail" sat at 3 of 200. Neither ratchet demands improvement; both
  // forbid regression, which is the only shape that survives contact with a real backlog.
  ['source-file-size ratchet', 'npm', ['run', 'verify:source-file-size-ratchet']],
  ['proven-red ratchet', 'npm', ['run', 'verify:proven-red-ratchet']],
  ['boundary', 'npm', ['run', 'verify:boundary']],
  // 260729: the last two P-2 baseline entries carrying a `diagnosis` were paid down. Both gates now
  // SPAWN themselves at a seeded temp root and OBSERVE the exit code instead of asserting their own
  // in-file fixtures. A control that nothing triggers is not a control, so they are wired here.
  // verify:customer-ecosystem-template had NO npm script at all before this — its only caller was
  // verify-customer-onboarding-composed-gate.mjs, which is itself wired nowhere.
  ['backend boundary controls', 'npm', ['run', 'verify:boundary:self-test']],
  ['customer ecosystem template', 'npm', ['run', 'verify:customer-ecosystem-template']],
  ['customer ecosystem template controls', 'npm', ['run', 'verify:customer-ecosystem-template:self-test']],
  ['runtime independence', 'npm', ['run', 'verify:no-mbp-runtime-dependency']],
  ['mounted-route authorization manifest controls', 'npm', ['run', 'verify:route-manifest']],
  ['API contract', 'npm', ['run', 'verify:contract']],
  // 260804 · a handler that hand-builds an INTERNAL_ERROR wrapper destroys the Postgres code that
  // errorEnvelope exists to preserve. Measured cost: `POST /documents` had NEVER once succeeded in
  // production and reported only INTERNAL_ERROR, while the same week `POST /intake/:id/execute`
  // failed identically and reported 42501 — which named the failing layer and led straight to a fix.
  ['error-code preservation controls', 'npm', ['run', 'verify:error-code-preservation:self-test']],
  ['error-code preservation', 'npm', ['run', 'verify:error-code-preservation']],
  // 260804 · a bare tagged-template parameter inside a variadic-"any" function (jsonb_build_object
  // et al.) raises 42P18 on EVERY call — a guaranteed runtime failure that mocks, typecheck and an
  // inline-literal SQL replay all miss. It broke POST /documents so completely the endpoint had
  // never once succeeded in production.
  // ITEM 23 · the projection-outbox gate itself needs a live DSN, so it runs in deploy:api, not
  // here. Its DECISION LOGIC is pure and must still be exercised somewhere that always runs —
  // otherwise the only thing standing between a no-consumer queue and production is a check nobody
  // has ever seen execute. Controls only; the live measurement is a deploy preflight.
  ['projection-outbox drain controls', 'npm', ['run', 'verify:projection-outbox-drain:self-test']],
  ['untyped variadic SQL parameter controls', 'npm', ['run', 'verify:untyped-jsonb-params:self-test']],
  ['untyped variadic SQL parameters', 'npm', ['run', 'verify:untyped-jsonb-params']],
  ['deploy provenance wiring', 'npm', ['run', 'verify:deploy-provenance']],
  ['Pages artifact-owned Sentry release', 'npm', ['run', 'verify:pages-sentry-release']],
  ['rate-limit buckets bound to real limiters', 'npm', ['run', 'verify:rate-limit-binding-parity']],
  ['Pages release artifact contract', 'npm', ['run', 'verify:app-pages-release:self-test']],
  ['Pages deployment decision contract', 'npm', ['run', 'verify:app-pages-decision:self-test']],
  ['deployed surface registry', 'npm', ['run', 'verify:deployed-surfaces']],
  // Until 260729 this line ran `verify:app-security-headers`, which was DEFINED as the script's own
  // `--self-test`. ci-local's only security-header gate was therefore the comparator's controls; the
  // real manifest/artifact check had no caller anywhere, and neither did the live check. Now the
  // real check runs here (manifest sanity + HSTS ramp policy + artifact parity when a release is
  // built), the controls run alongside it, `--require-artifact` runs fail-closed on the app deploy
  // chain where the artifact provably exists, and `--live` runs post-deploy.
  ['app security header parity', 'npm', ['run', 'verify:app-security-headers']],
  ['app security header parity controls', 'npm', ['run', 'verify:app-security-headers:self-test']],
  ['deploy schema-head contract', 'npm', ['run', 'verify:deploy-schema-head:self-test']],
  ['authority decision truth', 'npm', ['run', 'verify:authority-decision']],
  ['deployment authorization replay protection', 'npm', ['run', 'verify:deployment-authorization-store']],
  ['deployment authorization gate repo containment', 'npm', ['run', 'verify:deployment-authorization-store:self-test']],
  ['packet completion contract', 'npm', ['run', 'verify:packet-completion-contract']],
  ['typed work relationships', 'npm', ['run', 'verify:typed-work-relationships']],
  ['action intent shadow', 'npm', ['run', 'verify:action-intent-shadow']],
  ['role-skill catalog loader freshness', 'npm', ['run', 'verify:role-skill-catalog-loader-fresh']],
  ['role-skill publication receipt source integrity', 'npm', ['run', 'verify:role-skill-catalog-publish-receipt:self-test']],
  ['model execution callsite coverage', 'npm', ['run', 'verify:model-execution-callsites']],
  ['shadow observability storage', 'npm', ['run', 'verify:shadow-observability-storage']],
  ['backend trust proofs (static)', 'npm', ['run', 'verify:trust-proofs']],
  // The cross-tenant RLS proof needs a live disposable Postgres, so it cannot run here — but its
  // RUNNER can be proven offline. This entry asserts the runner still refuses to call a skipped
  // vitest run a pass and still exits 2 (not 0) when the DSNs are absent.
  ['cross-tenant RLS proof runner controls', 'npm', ['run', 'verify:cross-tenant-rls-proof:self-test']],
  ['rls grant parity', 'npm', ['run', 'verify:rls-grant-parity']],
  // Clerk↔DB membership parity needs a live Clerk secret + DSN, so the LIVE run belongs to
  // `verify:clerk-db-parity:live` (same split as rls-grant-parity). What runs here is the
  // comparator's own controls — including the observed exit 2 when credentials are absent, because
  // the failure this gate exists to catch (two systems disagreeing for two days in silence) would be
  // reproduced inside the detector by any version of it that goes quiet without secrets.
  ['clerk↔db membership parity controls', 'npm', ['run', 'verify:clerk-db-parity:self-test']],
  ['data schemas', 'npm', ['run', 'verify:data-schemas']],
  ['orphan tests', 'npm', ['run', 'verify:no-orphan-worker-tests']],
  ['prod-migration object-probe classifier', 'npm', ['run', 'verify:prod-migrations:self-test']],
  ['migration 090 SELECT-only preflight classifier', 'npm', ['run', 'preflight:migration-090:self-test']],
  ['migration 091 SELECT-only preflight classifier', 'npm', ['run', 'preflight:migration-091:self-test']],
  ['schema 91 disposable PostgreSQL release gate', 'npm', ['run', 'verify:schema91-postgres:self-test']],
  ['schema 92 production-drift replay bridge', 'npm', ['run', 'verify:schema92-replay-bridge']],
  ['schema 92 production-drift replay bridge controls', 'npm', ['run', 'verify:schema92-replay-bridge:self-test']],
  ['schema 93 source replay runner controls', 'npm', ['run', 'verify:schema93-source-replay:self-test']],
  ['operation-event source-tool constraint', 'npm', ['run', 'verify:operation-event-source-tool-constraint']],
  ['operation-event source-tool constraint controls', 'npm', ['run', 'verify:operation-event-source-tool-constraint:self-test']],
  ['pilot live RLS evidence producer', 'npm', ['run', 'produce:pilot-shadow-live-rls-evidence:self-test']],
  ['predeploy migration fail-closed classifier', 'npm', ['run', 'verify:predeploy-migration-gate:self-test']],
  // META-GATE P-2 and the three estate self-tests that actually OBSERVE a red. The meta-gate is a
  // ratchet over docs/contracts/GATE_SELF_REFERENCE_BASELINE.json: known violations are frozen, new
  // ones fail. verify:frontend-pair:self-test was the only x-backend self-test proven to observe a
  // red and NOTHING triggered it — the gate ran on deploy:api, its controls ran nowhere.
  ['gate self-reference meta-gate', 'npm', ['run', 'verify:gate-self-reference']],
  ['gate self-reference meta-gate controls', 'npm', ['run', 'verify:gate-self-reference:self-test']],
  ['frontend/API pair deploy gate controls', 'npm', ['run', 'verify:frontend-pair:self-test']],
  // 260729: three P-2 baseline entries were cleared by replacing in-file fixture assertions with
  // self-tests that SPAWN the gate and OBSERVE its exit code. A control that nothing triggers is not
  // a control, so they are wired here rather than left as an unrun flag.
  ['tenant source isolation controls', 'npm', ['run', 'verify:tenant-source-isolation:self-test']],
  ['domain scaffold honest-empty controls', 'npm', ['run', 'verify:domain-scaffold-honest-empty:self-test']],
  ['flag parse hygiene', 'npm', ['run', 'verify:flag-parse-hygiene']],
  ['flag parse hygiene controls', 'npm', ['run', 'verify:flag-parse-hygiene:self-test']],
  // 260730: verify-customer-onboarding-composed-gate exited 1 at b84d815 and was referenced by
  // NOTHING — no npm script, no entry here — so its red was invisible. Three of its eleven
  // sub-gates were donor-only paths that had never been ported (MODULE_NOT_FOUND on every run).
  // Fixed first, wired second: the gate is green on the real tree before this line exists. Its
  // self-test spawns the gate as a child process and observes a real red, so it is a control
  // rather than an assertion about its own fixtures.
  ['customer onboarding composed gate', 'npm', ['run', 'verify:customer-onboarding-composed-gate']],
  ['customer onboarding composed gate controls', 'npm', ['run', 'verify:customer-onboarding-composed-gate:self-test']],
  ['customer authority gates controls', 'npm', ['run', 'verify:customer-authority-gates:self-test']],
  // Release-debt visibility (260803). Advisory by default — it reports how far HEAD has drifted from
  // the LIVE deployed sha, which is the signal that was missing while 22 backend commits accumulated
  // undeployed across five sessions. The self-test is the gate on the gate: it proves the threshold
  // logic can go RED, including that "could not reach /health" is UNKNOWN and never "clean".
  ['release-debt controls', 'npm', ['run', 'verify:release-debt:self-test']],
  ['release-debt visibility', 'npm', ['run', 'verify:release-debt']],
  // MB-P projection freshness (260803). This verifier is correct and fail-closed and had ZERO call
  // sites — two consumers spawned it by name, but nothing in any gate chain ran it, so the staged
  // projection's lease expired 2026-07-18 and stayed expired silently. It is ADVISORY here because
  // clearing it requires an owner-approved MB-P re-export, which this runner cannot perform; making
  // it blocking would create a red with no path out and get the gate deleted instead of the lease
  // renewed. Advisory means it is finally READ.
  ['MB-P projection freshness', 'npm', ['run', 'verify:mbp-projection-freshness'], { advisory: true }],
  // The meta-gate (260803). Six controls in this estate were found reporting success while
  // evaluating nothing; on first run this detector found 17 across 236 scripts, including the
  // "207/207 files" test-batch line and the "219/219 classified" route-manifest line — both
  // templates over a single constant, neither ever a pass RATE. ADVISORY because 17 pre-existing
  // findings cannot be cleared in one wave, and a meta-gate that blocks on day one gets deleted
  // instead of drained. Its own self-test runs first and IS blocking.
  ['hollow-success controls', 'npm', ['run', 'verify:controls-measure-something:self-test']],
  ['hollow-success scan', 'npm', ['run', 'verify:controls-measure-something'], { advisory: true }],
  // Schema-93 DB contract (260803). Migration 093 re-namespaced the idempotency keys guarding NINE
  // authority writes, and every schema93 suite opens with `databaseUrl ? describe : describe.skip`
  // — so without XLOOOP_SCHEMA93_PG_URL, which is every machine in a repo with no CI, the proof was
  // skipped and vitest still reported success. The contract shipped asserted only by mocks.
  // Proven 2026-08-03 against real Postgres at schema 93: 11/11. Two facts it surfaced are NOT
  // readable from the migration source — a reused key with a DIFFERENT digest also raises 23505
  // (so the DAL's digest comparison, not the DB, separates replay from a 409), and the ordinary and
  // strict key namespaces really are independent. BLOCKING is safe here precisely because the skip
  // is honest: unset prints "SKIPPED (0 of 11 invariants asserted)" and exits 0, but exits 1 under
  // XLOOOP_AUTHORITY_MODE=production, where an unproven migration contract is a red, not a shrug.
  ['schema-93 invariant controls', 'npm', ['run', 'verify:schema93-invariants:self-test']],
  ['schema-93 DB contract', 'npm', ['run', 'verify:schema93-invariants']],
  ['typecheck', 'npm', ['run', 'typecheck']],
  ['worker suite', 'npm', ['test']],
];

// MEASURED, NOT DECLARED (260803). This summary previously printed
// `${gates.length}/${gates.length}` — a template over the SAME constant on both sides, so it was
// structurally incapable of reporting anything but N/N. Combined with the `break` below, a run that
// died on gate 3 of 64 either exited non-zero with no tally, or (on the success path) printed
// "64/64" having genuinely executed 64. The number was therefore never evidence of coverage; it was
// the length of an array. It was read as a pass rate in release notes and session reports, and it
// collided with a "64/64" in PLATFORM_FACADE_SPEC.md that refers to a script which does not exist in
// this repo, which made two unrelated constants look like corroboration.
//
// Now: count what actually ran, and name what did not. The break is retained — failing fast is
// correct — but the gates it skipped are reported instead of vanishing.
// ADVISORY GATES (260803). A gate tuple may carry a 4th element { advisory: true }. An advisory
// gate RUNS and REPORTS but does not break the chain.
//
// This exists for a specific, real shape: a control that is correct and fail-closed, but whose red
// state can only be cleared by someone other than the person running the build. Wiring such a gate
// as blocking manufactures a red with no path out — the "remediation that cannot clear" defect this
// estate has already paid for elsewhere — and the predictable response is that someone deletes the
// gate. Advisory keeps the signal without creating that pressure.
//
// It is NOT a soft-fail escape hatch for gates you own. If you can fix it, it blocks.
let passed = 0;
let failedGate = null;
const advisoryFailures = [];
for (const [name, command, args, opts] of gates) {
  console.log(`\n=== ${name}${opts?.advisory ? ' (advisory)' : ''} ===`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    if (opts?.advisory) {
      advisoryFailures.push(name);
      console.error(`ADVISORY-FAIL ${name} (exit ${String(result.status)}) — reported, not blocking`);
      passed += 1;
      continue;
    }
    failedGate = { name, status: result.status };
    console.error(`FAIL ${name} (exit ${String(result.status)})`);
    break;
  }
  passed += 1;
}

const attempted = failedGate ? passed + 1 : passed;
const skipped = gates.length - attempted;

if (failedGate) {
  console.error(
    `\nFAIL x-backend local authority stack: ${passed}/${gates.length} passed, `
    + `1 failed (${failedGate.name}), ${skipped} NOT RUN`,
  );
  process.exit(1);
}
if (advisoryFailures.length) {
  console.log(
    `\nPASS x-backend local authority stack (${passed}/${gates.length} gates executed, 0 skipped) `
    + `— ${advisoryFailures.length} ADVISORY failure(s): ${advisoryFailures.join(', ')}`,
  );
  console.log('  Advisory reds are real findings that this runner cannot clear. Do not ignore them.');
} else {
  console.log(`\nPASS x-backend local authority stack (${passed}/${gates.length} gates executed and passed, 0 skipped)`);
}
