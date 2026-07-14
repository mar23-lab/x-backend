# Gate-disposition ledger (260711-H Phase 2b/2c prep) — how the 90 ci-local gates split at cutover

The design review ranked "contract-gate decay" risk #5 and required this decided BEFORE the x-backend
seed. Classification is EVIDENCE-BASED (each gate's script grepped for the surfaces it reads), not by name.

> **260711-I CORRECTION (pressure-tested against source):** 6 gates originally filed class-A were
> PROVEN to fail in a workers-only tree and are RECLASSIFIED below (see "Class-A corrections").
> Treat the class-A list as verified-per-gate, and the seed-rehearsal receipt as the final authority.

## Surface census (scripts/verify-*.mjs, whole tree)
- 89 scripts read `src/workers` / `functions/` (backend)
- 209 scripts read `src/widgets` / `src/shared` / `dist` / `index.standalone` (frontend)
- ~35 read BOTH — almost all end-to-end integration smokes (verify-project-*, verify-r55-*,
  verify-*-runtime-smoke) asserting a widget against a worker. These test the OLD UI -> they DIE with the
  archive; the new front gets its own. Only the true contract gates (below) survive as a boundary.

## The 4 classes (rule the fork script applies to ci-local's 90 gate ids)

### A · x-backend — FORK VERBATIM (VERIFIED to read only workers/functions/data/backend-docs)
data-schemas · no-hard-delete-customer · data-class-declared · allowed-actions-server-derived ·
no-orphan-worker-tests · admissibility-enum-ssot · audit-coverage · rls-runtime-enforcement ·
principal-instrument-lineage · principal-redaction · session-identity-axes ·
model-runtime-secret-safety · document-version-chain · sentry-wired · session-event-audit ·
verify:migration-state-ssot · verify:governance-manifests · verify:context-reaches-consumer ·
verify:translator-live-verification · typecheck:workers · verify:agent-roles-parity ·
verify:production-readiness-state (git-aware freshness — seed copy must be a COMMITTED git repo) ·
verify:unified-graph-invariants · verify:op-events-append-only · verify:project-events-visibility-floor ·
verify:causation-traceability · verify:customer-zero-journey-governed · verify:projection-substrate-evidence ·
verify:paid-pilot-access-identity · verify:tenant-source-isolation · verify:postgres-rls-phase2 ·
verify:ip-boundary-suite · verify:route-boundary-source-only · projection-cron-liveness ·
verify:no-raw-operation-events-insert · secret-scan · spine-vocabulary · seed-contract-parity ·
merged-contract-ledger ·
**verify:worker-unit-suite-{routes,stores,lib-a,lib-b}** (260711-I C2 burn-down: the 97
formerly-baselined worker unit tests, explicit arrays, born warn-tier then PROMOTED to BLOCKING
after a 5x green soak; all files read only src/workers — fork verbatim; at seed time the 3 facade
tests are already excluded because they were never gated, and the emptied baseline drops
max_orphans to 0).
MACHINE-COUPLED (class A but abs-path dependent; fine same-machine, flag for CI portability):
verify:identity-contracts (reads /Users/.../xcp-platform) · merged-contract-ledger freshness WARN
(reads /Users/.../x-ai-front).

### Class-A CORRECTIONS (260711-I — proven to FAIL workers-only; reclassified)
- `verify:deployed-surfaces` → **C/SNAPSHOT-PIN or split**: reads `src/app/routing/InvestorHostRouter.jsx`.
- `verify:execution-pipeline-parity` → **C/split**: reads `src/runtime/operator-capture.js` (the
  enqueue-verb half is frontend).
- `data-source-truth` → **D (dies) or split**: reads cockpit-stream-source JSX + ReadinessJourney
  widget as unconditional constants.
- `verify:ops-live-stream-shape` → **needs a fix before fork**: reads `src/app/App.jsx`
  unconditionally even in --shape-only; either strip that read or snapshot-pin it.
- `verify:auth-tenant-boundary` → **split required first**: reads src/shared read-models +
  AuthProvider + ScopedInteractions; the "backend half" does not exist yet as a separable script.
- `verify:governance-pillars` → **A with LOCKSTEP FORK**: the script is backend-safe but
  `GOVERNANCE_PILLARS.yml` references frontend gate ids (status-redaction, tenant-bundle-isolation,
  dws-operator-only-spaces, registry-ledger-compare, backend-ui-contracts, precutover-*) — the YAML
  must be forked in the same commit as the ci-local fork or the gate is RED.
- `smoke (backend subset)` → **DOES NOT EXIST**: smoke-cli.v3-source.mjs is a 4,654-line monolith with
  ~51 inseparable src/workers references. The subset is EXTRACTION WORK at the real seed (or the
  backend fork ships without a smoke gate initially, relying on the vitest suites) — known-gap.

### B · CONTRACT BOUNDARY — producer x-backend PUBLISHES a versioned artifact, consumer x-ai-front PINS by hash
- `spine-vocabulary` — producer x-backend (SSOT = workers/lib/permissions + spine-authority + the JSON);
  x-ai-front pins `spine-authority-vocabulary.v1.json` and gates its control map against it.
- `seed-contract-parity` — producer x-backend (validates the fixture vs backend truth); x-ai-front is the
  fixture SOURCE; the gate lives in x-backend reading a published copy.
- `merged-contract-ledger` — x-backend (reads the pinned manifest; freshness WARN watches the export).
- `connector-provider-ssot` — reads BOTH; x-backend keeps the registry-side assertion, the widget-side
  check dies with the old UI (new front supplies its own provider list when it wires connectors).

### C · SNAPSHOT-PIN — freeze the old-UI consumed surface as a fixture, port the gate to x-backend reading it
- `old-ui-consumes-envelope` — reads src/shared (old UI hooks + envelope reader). Snapshot the
  consumed-envelope shape to a fixture; the gate becomes "the served envelope still satisfies the frozen
  old-UI consumer" (protects app.xlooop.com until the new front takes over). Retire at new-front cutover.
- `backend-ui-contracts` — reads src/contracts (frontend TS contract types). Snapshot the 4 required
  export names/shapes; gate reads the fixture. Retire at new-front cutover.

### D · frontend-die — NOT ported (React-era gates against a single-file prototype are cargo cult)
Everything reading src/widgets/dist/storybook: current-integrity · perf-budget · status-redaction ·
render-vocab-leak · bundle-completeness · sidecar-manifest · sidecar-heal-selftest · host-css-render ·
verify:fsd-boundaries · component-size · component-findability · decomposition-safety · sidecar-render-safety ·
verify:component-reuse-map · verify:reuse-adoption-ratchet · verify:capture-field-parity ·
verify:dead-code-candidates · verify:ia-001-* · verify:raw-served-widgets · verify:token-template ·
verify:scope-symmetry · verify:declutter-never-hides · verify:first-run-guide-real · verify:tenant-bundle-isolation ·
verify:clickability-affordance-coverage · verify:cockpit-ask-first-invariants · verify:connector-no-dead-stub ·
verify:chat-widget-controls-backed · verify:cache-token-completeness · typecheck (app) · test:smoke ·
verify:envelope-reader · verify:boot-wire-deployed-entry · verify:readiness-journey-parity (UI half) ·
verify:precommit-autostage-contract (REPO-SCHEMA — regenerate fresh per repo, don't port) · the ~35
both-reading integration smokes. x-ai-front starts with a NEW minimal stack (size budget · link check ·
later the envelope-consumption check against the published spine vocabulary).

## Ambiguity policy (the fork script re-derives class A mechanically)
A ci-local gate whose script reads ONLY workers/functions/data-schemas/backend-docs -> class A; reads any
widgets/dist/shared -> class D unless it is one of the 6 named class-B/C gates. A gate resolving to a
vitest file list (no script path) is classified by whether its test files live under src/workers/__tests__
(-> A) or elsewhere (-> D). `test:unit` and `verify:current-integrity` are composite -> each repo gets its own.
