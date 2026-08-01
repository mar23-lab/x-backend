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
