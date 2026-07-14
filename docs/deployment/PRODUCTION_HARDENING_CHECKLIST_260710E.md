# Production-hardening checklist · 260710-E/F (operator console actions + staged remainder)

All items read-verified against live settings/repo on 260710-11. Each is an OPERATOR action
(console or named step) — none are agent-executable (harness-gated classes). Tick + date on completion.

## 1 · Neon (prod project `flat-truth-23350426`, Sydney)

| # | Item | Current (verified) | Target | Why |
|---|---|---|---|---|
| 1.1 | **PITR history retention** | **6 hours** (21600s) | **≥ 7 days** | 6h is a demo-grade recovery window: a bad write discovered next morning is UNRECOVERABLE. This is the single biggest data-risk item on the list. Console → Project settings → History retention. |
| 1.2 | IP allowlist | empty (all IPs) | Workers egress ranges or documented-open | DB reachable from any IP with the connection string; RLS is the 2nd layer but network is the 1st. If left open, record the acceptance in this file. |
| 1.3 | `block_public_connections` | false | review | Pairs with 1.2 (Neon private-link/VPC is overkill at this stage — decide + record). |
| 1.4 | Drop validation branch | `br-crimson-cell-a7nvohl2` present | delete after 042/062/063 apply | The 260710-D branch-validation clone; retained until the prod applies land (its proofs are recorded in ACTIVATION-TRAIN-260710-D.md). |

## 2 · Observability

| # | Item | Current | Target |
|---|---|---|---|
| 2.1 | `emitEvent` sink | console.log only (Workers Logs, bounded retention) | DECISION needed: Workers Logpush (zero code change) vs queue fan-out (code). Sentry is live for errors; this is about METRICS/audit-lines durability. Recommend Logpush first (config-only). |
| 2.2 | Deploy receipts | **CLOSED 260710-F** — `npm run deploy:api:receipt` (scripts/emit-deploy-receipt.mjs) refuses on build/HEAD mismatch | run after every API deploy |
| 2.3 | Deployed-projection freshness probe | none (both gates check the LOCAL file only) | lands with M4 (day-1 operator-loop probe) + the H1 rail makes freshness a served field |

## 3 · Remaining activation train (from ACTIVATION-TRAIN-260710-D.md — harness-gated, operator-named)

1. Apply migrations **042** (append-only trigger) · **062** (member soft-remove) · **063** (mcp_access_log) — all three BRANCH-VALIDATED on the Neon clone; 042's allow-list/block behavior proven on a real prod row.
2. Flip `MEMBER_REMOVAL_ENABLED` (probe: remove ⇒ roster excludes + entitlement revoked).
3. Tranche B one at a time with probes: `FEEDBACK_PERSISTENCE_ENABLED` → `CHAT_RECEIPT_GROUNDING_ENABLED` → `CUSTOMER_API_TOKENS_ENABLED` (+`CUSTOMER_OPERATIONAL_TOKENS_ENABLED`) → `SOURCE_SCOPE_ENFORCEMENT_ENABLED` (**never solo — hard-paired to the Gmail-additionalScopes OAuth bundle**).
4. Flip `SOURCE_TIER_GROUNDING_ENABLED` (D-16 read-side) · `GRAPH_DOCUMENT_NODES_ENABLED` (+ graph rebuild).
5. App-bundle deploy (D-1) — **boot-wire verification via esbuild metafile, never the preview harness** (the prior wrong-entry incident shipped dead code).
6. Flip the L1/L2 flags (`CHAT_ASSEMBLY_TRACE_ENABLED`, `MCP_READ_AUDIT_ENABLED`) after 063 applies.
7. Promote `verify:governance-pillars` warn→blocking (GREEN at promotion — house pattern).
8. **Dogfooding bridge activation (260710-F):** export `XLOOOP_INGEST_TOKEN` (= the `ACTIVITY_INGEST_TOKEN` secret value) in the dev shell → per-wave activity events flow (runbook: cockpit-live-ingestion.md §DEV-AGENT WAVE PROTOCOL). After step 3's token flags: mint ONE operator token (`POST /api/v1/developer-access/tokens`) → `XLOOOP_OPERATOR_TOKEN` → `scripts/report-wave-to-spine.mjs --post` for governed-grain reporting.
9. **H1 flip (260710-F M4):** after the MB-P seat POSTs the first compound projection envelope to `POST /api/v1/mbp-projection/ingest`, flip `MBP_PROJECTION_LIVE_RAIL_ENABLED` (dashboard var, no redeploy) → `GET /api/v1/mbp-projection` serves db_live with honest freshness.

## 4 · Staging posture (recorded decision)

No dedicated staging env. Compensating controls: flag-gated default-off deploys (byte-identical),
Neon branch validation for DDL, per-flag smoke probes, canary tokens (read + fenced lifecycle), and
ci-local as release authority. Acceptable at current scale; revisit at first external-team hire or
first enterprise SLA with staging clauses.

## 5 · Contractual exposures (surfaced by the MB-P commercial sweep — before next customer signature)

- SLA promises 99.9% + weekly MTTA/MTTR while production monitoring runs from a sleeping-capable laptop (MB-P recommendation `33867152…`).
- DPA promises backup/DR drills that have never been run (`0c2b0111…`) — note 1.1 (6h PITR) makes the DR promise currently unmeetable; fixing 1.1 is the first DR drill prerequisite.
