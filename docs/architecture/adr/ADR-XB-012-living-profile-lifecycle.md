# ADR-XB-012 — The Living Profile Lifecycle (seed → capture → materialize → apply → measure)

- **Status:** proposed (design ratification requested — the APPLY stage is a live customer-LLM change and the PUBLISH stage wires a currently-inert platform catalog; both warrant operator sign-off before the runtime PRs land)
- **Date:** 2026-07-21
- **Authority context:** mig 035 `template_policy_registry` (`template_definitions` / `template_versions` / `tenant_template_bindings` / `user_template_overlays` / `effective_template_snapshots`); mig 036 `customer_learning_personalization` (`user_learning_signals` / `user_personalization_profiles` / `tenant_learning_profiles` / `tenant_learning_promotions`); the READ-side resolvers `resolveEffectiveTemplatesRow` + `getEffectivePersonalizationProfileRow` (`dal/template-policy-store.ts:242,376`); the customer-LLM system-prompt seam (`services/cockpit-chat.ts:952-953`, `companyContextPreamble`); ADR-XB-005 (events are not work items) + the operator-signal-pollution prohibition (no fabrication); ADR-XB-011 (resource recoverability contract). Grounded in the 2026-07-21 personalization ground-truth pass.

## Context — a fully-built read side over a fully-empty write side

Xlooop already contains a correct, layered personalization ENGINE and consumes **none** of it for customers. Measured, per stage:

| Stage | State | Evidence |
|---|---|---|
| **CAPTURE** | WIRED | `POST /template-policy/personalization/signals` → `createUserLearningSignalRow` (`template-policy-store.ts:477`); consent-gated (`consent_ref` required for any non-`user_private` class; service tokens 403'd). |
| **Read-side resolver** | BUILT, UNCONSUMED | `resolveEffectiveTemplatesRow` composes platform→vertical→tenant→workspace→user with `FORBIDDEN_OVERRIDE_KEYS` stripping; `getEffectivePersonalizationProfileRow` composes company+user profiles. Both are called **only** from the registry GET routes (`template-policy-registry.ts:231,301`) — **neither `customer-chat.ts` nor `cockpit-chat.ts` calls them.** |
| **SEED** | EMPTY | `provisionCustomerWorkspaceRow` + `customer-template.sql` seed workspaces/users/members/consents/projects/events — **zero** template bindings, profiles, or tone. |
| **PUBLISH (platform catalog)** | EMPTY (deeper than "no writers") | The `role-skill-catalog-publisher` that inserts the 11 platform `template_definitions` is **not wired to any deploy/cron/route** — referenced only in a test. So `template_definitions` is empty at runtime, and `resolveEffectiveTemplates` returns nothing to bind to. |
| **MATERIALIZE** | EMPTY | No cron reads signals → profiles. `user_personalization_profiles`, `tenant_learning_profiles`, `effective_template_snapshots` have **zero application writers**. |
| **APPLY** | EMPTY | The customer system prompt (`cockpit-chat.ts:953`) uses only `companyContextPreamble` (from `readiness_assessments`). The resolved profile/tone is never injected. |
| **MEASURE** | WIRED-ish | Read-only customer-census arm exists (`crons/index.ts`), not personalization-specific. |

**The one structural trap the schema itself flags:** `tenant_learning_profiles.approval_ref TEXT NOT NULL` (mig 036:70). That table is the **promoted, consent-gated, admin-approved shared-learning** home — written only via `tenant_learning_promotions`. A system-seeded "starter profile" written there at provisioning would carry no genuine approval and **would violate the table's governance model.** The starter must not live there.

## Decision — the Living Profile lifecycle, and where each artefact lives

1. **The starter lives in the TEMPLATE-BINDING layer, never in `tenant_learning_profiles`.** A new workspace is SEEDED by binding it (`tenant_template_bindings`) to published platform/vertical `template_definitions`. The learning tables (`user_personalization_profiles`, `tenant_learning_profiles`) are populated ONLY by the capture→materialize→promote path, never by provisioning. This respects `approval_ref NOT NULL` (promotion carries the approval) and keeps "what the platform ships" separate from "what this tenant learned."

2. **PUBLISH before SEED.** Bindings are meaningless until platform `template_definitions` exist. The `role-skill-catalog-publisher` is wired to run idempotently at deploy time (or a chained cron), publishing the platform catalog, before any provisioning binds to it. This closes a built-not-bound gap, not a new build.

3. **No fabrication — the starter PROJECTS from the customer's own readiness answers.** Account type, maturity (L0–L5), and growth posture (already captured in `readiness_assessments`) select which published pack a workspace binds to and seed sensible `shared_defaults_json` preferences. Nothing about the customer's voice, goals, or tone is invented — the same rule the charter seed follows and the operator-signal-pollution prohibition demands. A tone the customer never expressed is never written.

4. **The learning half writes the private layer immediately, the shared layer only through promotion.** MATERIALIZE writes `user_personalization_profiles` (private to the user, immediate) from that user's signals; it writes `tenant_learning_profiles` (company-shared) ONLY when an admin/operator promotion + consent_ref exists (carrying `approval_ref`). The materialize cron **chains onto an existing daily trigger slot** (the `crons/index.ts` composite) — never a 6th Cloudflare trigger (the account is at the 5-trigger cap; a standalone expression would silently never fire).

5. **APPLY is a live customer-LLM change → mandatory shadow-compare, born-OFF.** The effective profile + tone is injected at the system-prompt assembly seam (`cockpit-chat.ts:952-953`), behind a born-OFF flag. Acceptance requires a capturing test proving that an absent/empty/all-null profile yields a **byte-identical** system prompt (the exact discipline the charter grounding used). The profile augments, never silently replaces, `companyContextPreamble`.

6. **The forbidden set (enforced, not advisory):** never write `tenant_learning_profiles` from provisioning or any non-promotion path; never fabricate a customer tone/voice/preference not derivable from their own inputs; never add a 6th Cloudflare trigger; never flip APPLY without a passing shadow-compare; never let a resolved overlay override a `FORBIDDEN_OVERRIDE_KEYS` field (security/retention/redaction/tenant-isolation) — the resolver already strips these and the seed must not reintroduce them.

## The ordered runtime PRs (each Neon-branch-verified, born-flag-OFF)

1. **PUBLISH** — wire `role-skill-catalog-publisher` to a deploy/idempotent seam so platform `template_definitions` exist. Verify: after deploy, the catalog is non-empty; re-run is idempotent.
2. **SEED** (`PERSONALIZATION_SEED_ENABLED`) — provisioning binds the workspace to the published pack selected by its readiness answers, seeding `tenant_template_bindings` + `shared_defaults_json` preferences (projected, not fabricated). Verify on a Neon branch: re-provision → non-empty `resolveEffectiveTemplates`; no `tenant_learning_profiles` write; re-provision is idempotent/edit-preserving.
3. **APPLY** (`PERSONALIZATION_APPLY_ENABLED`) — inject the effective profile/tone at `cockpit-chat.ts:952-953`. Verify: capturing test proves empty-profile → byte-identical prompt; shadow-compare measures the answer delta before flip.
4. **MATERIALIZE** (`PERSONALIZATION_MATERIALIZE_ENABLED`) — the signals→profile cron chained onto the daily composite slot; writes private profiles immediately, shared profiles only via promotion+consent. Verify: synthetic signal → private profile row; promotion+consent → shared row with `approval_ref`; RLS blocks cross-tenant.
5. **MEASURE** — a census personalization plane: per customer, is the effective profile fresh / non-empty / converging. Rides the existing census observation-row pattern.

## Consequences

- **Easier:** a new customer opens to a shaped, customisable workspace (bound to a real pack) instead of the platform-empty default; the customer's agent grounds on their accumulated, consented learning; "why did the assistant answer this way" is auditable through the resolver's layered output + `forbidden_override_keys`.
- **Harder / to watch:** APPLY changes the live customer answer surface — it MUST stay behind the shadow-compare gate; the PUBLISH wiring makes a previously-inert catalog load-bearing (its content becomes a governed surface); the promotion path is the only door to the shared layer, so tenant-wide personalization is deliberately slower than private personalization (correct — shared learning needs consent).
- **Revisit when:** vertical packs multiply (the pack-selection logic grows), or a customer requests a frozen/opt-out profile (a `lifecycle_state='paused'` on their profile — the schema already supports it).

## Faster-path considered (HR-FASTEST-QUALITY-PRESERVING-PATH-1)

| Faster path | Why rejected | Quality-loss risk |
|---|---|---|
| Seed a `tenant_learning_profiles` starter row at provisioning | violates `approval_ref NOT NULL` governance (that table is promotion-only); conflates platform-ships with tenant-learned | a system row masquerading as an approved shared learning — ungoverned data in the audit-critical table |
| Seed bindings without publishing the catalog first | binds to an empty `template_definitions` → resolver still returns nothing | inert seed that reads as "done" while delivering zero shaping |
| Fabricate a starter tone by account-type | no consented voice data at day 0; the operator-signal-pollution class | a customer opens to a voice that is not theirs |
| Flip APPLY straight to on | an untested profile injection can silently degrade every customer answer | live-LLM regression with no shadow baseline |
| Add a 6th Cloudflare trigger for the materialize cron | the account is at the 5-trigger cap — a 6th expression silently never fires | the materialize loop looks scheduled but never runs (the dead-cron class) |
