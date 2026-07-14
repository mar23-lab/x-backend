# Xlooop go-live activation sheet — one ordered list (260711)

Every code deliverable across the 260710-D / 260710-F / SF waves is **landed + deployed** (main `f3226a89`,
deployed API `e962adf1`). What remains is a sequenced set of OPERATOR actions — each flips a currently-inert,
already-wired-and-tested path live. This sheet supersedes the scattered steps in ACTIVATION-TRAIN-260710-D.md,
PRODUCTION_HARDENING_CHECKLIST_260710E.md, and SAFETY_FLOOR_ACTIVATION_260711.md (kept for detail; this is the order).

Legend: **[O]** operator-only (harness-blocked or secret) · **[X]** cross-repo (x-web / MB-P seat) · **[A]** an agent can do it (noted where I already did).

## Phase 0 — hygiene (do first, 1 minute)
1. **[O]** Restore local `source==production` in the primary checkout: `cd ~/WIP/Xlooop/Xlooop-XCP-demo && git fetch && git merge --ff-only origin/main`. (Pure fast-forward; origin already has everything. Your local main is unfetched, not divergent.)

## Phase 1 — safety floor (closes the live publicly-exploitable exposure — do before any self-serve)
2. **[O]** Durable signup limiter: uncomment `[[ratelimit]] RATE_LIMITER_SIGNUP` in `wrangler.toml` (~L67-70) → `npm run deploy:api`. Fixes the bypassable in-isolate limiter. Verify: >5 `POST /request-access`/min/IP → 429 that persists across isolates.
3. **[X]** x-web: render the Turnstile widget (SITE key) on the request-access form.
4. **[O]** After step 3: `wrangler secret put TURNSTILE_SECRET` (do NOT do before 3 — the funnel hard-403s real users otherwise). Verify: tokenless post → 403 `TURNSTILE_FAILED`.
5. **[O]** After step 2: flip `SAFETY_FLOOR_RATELIMIT_ENABLED=true` (dashboard var, no redeploy) → per-user caps on customer-chat (60/min) + readiness (10/min). Rollback = unset.
   - *(SF-1 cron→Sentry is already LIVE — it deployed with the SF wave; SENTRY_DSN was already bound. No step.)*

## Phase 2 — apply the branch-validated migrations (harness-blocked → you run them)
6. **[O]** Apply **042** (operation_events append-only trigger — re-grep `UPDATE operation_events` writers first, all allow-listed as of validation), **062** (workspace_members.removed_at), **063** (mcp_access_log) to prod Neon. All three were branch-validated on clone `br-crimson-cell-a7nvohl2` (042's allow-list/block proven on a real row). `workers_schema_version` head 61 → 63. Then drop the validation branch.

## Phase 3 — activate the built-flag-off features (each after its migration)
7. **[O]** After 062: flip `MEMBER_REMOVAL_ENABLED` → soft member removal live.
8. **[O]** After 063: flip `MCP_READ_AUDIT_ENABLED` + `CHAT_ASSEMBLY_TRACE_ENABLED` → durable MCP-read + chat-assembly audit.
9. **[O]** Tranche B, one at a time with a smoke each: `FEEDBACK_PERSISTENCE_ENABLED` → `CHAT_RECEIPT_GROUNDING_ENABLED` → `CUSTOMER_API_TOKENS_ENABLED` (+`CUSTOMER_OPERATIONAL_TOKENS_ENABLED`). **`SOURCE_SCOPE_ENFORCEMENT_ENABLED` — never solo; hard-paired to the Gmail-additionalScopes OAuth bundle (x-web).**
10. **[O]** `SOURCE_TIER_GROUNDING_ENABLED` (D-16 read-side; store already live) · `GRAPH_DOCUMENT_NODES_ENABLED` (+ `POST /graph/rebuild`).

## Phase 4 — the B2 projection hotfix (H1, the permanent fix — 2 steps)
11. **[X]** MB-P seat: `node scripts/push-mbp-projection-to-workers.mjs` → posts the fresh compound projection+manifest to the live rail (its Jul-11 source is fresh).
12. **[O]** Flip `MBP_PROJECTION_LIVE_RAIL_ENABLED=true` (dashboard var, no redeploy) → `GET /mbp-projection` serves db_live with honest freshness; the empty-stub/expired-lease class is gone. (H1 replaces the fragile daily repo-commit staging entirely.)

## Phase 5 — frontend + hardening
13. **[O]** App-bundle deploy (D-1) — **verify boot-wire via the esbuild metafile, NEVER the preview harness** (the prior wrong-entry incident shipped dead code).
14. **[O]** Neon: PITR history retention 6h → ≥7d (biggest data-risk item; also the DPA-DR prerequisite); review IP allowlist / `block_public_connections`.
15. **[A/done]** `verify:governance-pillars` promoted warn→blocking (SF wave, this sheet's commit). No action.

## Phase 3b — metering (260711-G addendum; the staircase prerequisite is now BUILT)
10b. **[O]** Apply migration **064** (`llm_usage_log` — double-apply + upsert semantics validated on local PG) →
     flip `LLM_USAGE_METERING_ENABLED` (dashboard var) → smoke: ask a Claude/Llama chat in a customer workspace,
     then `GET /api/v1/llm-usage` as owner ⇒ a (workspace, model, user, today) row with calls/tokens.
     This unblocks the metering→Stripe→pricing staircase; the pricing/self-serve flips in Phase 6 stay gated
     on Stripe + the safety floor. Interim projection note: G1 re-staged the fresh Jul-11 projection (cockpit
     un-expired via the inlined fallback until you flip H1 in Phase 4).

## Phase 6 — commercial (your + counsel's call, before next customer signature)
16. Respond to the two contractual-exposure recommendations: SLA-vs-laptop-monitoring (`33867152`) and DPA-vs-never-run-DR (`0c2b0111`) — remediate vs amend is a **legal** decision. Fixing Phase 5 step 14 (PITR) is the first DR-drill prerequisite.
17. The C-0…C-5 commercial staircase + per-tenant metering (before any pricing/self-serve flag) — cross-repo (MB-P customer plane).

## Hard stops I hit under "proceed in full" (why they're on your list, not done)
- **Prod-DB migrations (6):** the harness auto-mode classifier denies agent prod-DB writes — interactive operator approval required. Validated + ready, not applyable by me.
- **Secrets (4, 14):** `wrangler secret put` needs the secret VALUE + is a prohibited action class for an agent — operator-only.
- **Customer-facing flag flips (5, 7-12):** most depend on a harness-blocked migration or a cross-repo widget; the rest change live customer behavior and belong with operator eyes per the named-authorization discipline.
- **App-bundle deploy (13):** the boot-wire metafile verification is a known-dangerous solo step.
