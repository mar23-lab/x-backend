# Operator-axis authority — decision record + staged cutover (260708)

**Status:** machinery BUILT + PROVEN, INERT. Production authority is UNCHANGED (still role-derived). The
cutover to entitlement-backed authority is operator-gated + staged (below). This doc is the OA-0 decision
record for the Wave OA-SAFE pass and the frontend-team `handoff` bundle it adapts.

## 1. The four identity axes (keep them separate)
- **MembershipRole** — *who the actor is* (`Owner|Admin|PM|Engineer|Designer|Compliance|Client|Viewer|Agent|
  Service`, capitalized; `dal/types/xcp-identity-contracts.ts`). The wire `AuthContext.role`
  (`owner|operator|viewer|client`) is the legacy R40 projection of this.
- **OperatingMode** — *what authority is active this session* (`watch|test|operator`). A governed write
  commits only in `operator` mode.
- **AppEntitlement** — *which modes/actions are reachable* (`allowed_modes`, `allowed_actions`,
  `denied_actions`, `status`, expiry). The real per-principal grant.
- **Visibility / client-exposure** — `visibilityForRole()` server-side allow-set (owner=4 levels … client=
  public_safe only).

## 2. The defect (verified in source)
`operator` is BOTH a `WorkspaceRole` value AND an `OperatingMode` value — a genuine collision. The legacy
gates `canWrite(role)` / `isOperatorRole(role)` (`lib/permissions.ts`) treat "is in operator mode" as if it
were a durable role, and never consult the entitlement. Worse, `dal/principal-adapter.ts::buildPrincipal()`
**fabricates** the xlooop `AppEntitlement` from the role: `allowed_modes = modesForRole(role)`,
`allowed_actions = ['*']`, `denied_actions = []`, `status = 'active'` (all hardcoded). So
`canActOnSpine(buildPrincipal(...)) ≡ canWrite(role)` today — wiring the canonical helper without a real
source would be **security theatre**. The conflation is systemic (12 `canWrite` + ≥10 inline role checks).

## 3. The real source exists but is EMPTY (the load-bearing fact)
Migration `018_customer_registration.sql` creates `customer_entitlements` (allowed_modes/allowed_actions/
denied_actions/revoked_at/authority_ref). **Prod-verified: the table has 0 rows and 0 writers** — it is
created, indexed, never written, never read. Therefore a fail-closed reader-only flip would make
`evaluateAppAccess` return `missing_entitlement` for EVERY user (incl. the owner) → **100% write lockout**,
not a tightening. The real P0-0 is reader + WRITER (backfill) + a grant policy, staged so no real user is
ever denied.

## 4. Decisions
- **GRAIN = per-(user, workspace)** (operator, 260708). Prod is multi-workspace (11 active memberships / 4
  users). The table's current `UNIQUE(user_id, app_id)` cannot express per-workspace authority and would let
  operator authority leak across tenants (owner-in-A ⇒ operator-in-B). The cutover changes it to
  `UNIQUE(user_id, workspace_id, app_id)`; the reader (`dal/entitlement-store.ts`) scopes by `workspace_id`.
- **No-lockout backfill first.** A role-mirror backfill grants every ACTIVE membership an entitlement that
  reproduces today's authority (owner/operator → `['watch','test','operator']` + `['*']`; viewer/client →
  `['watch']`), so the flip is behaviour-preserving. Tighten to least-privilege LATER as a data op.
- **Legacy gates deprecated, not removed.** `canWrite`/`isOperatorRole` are `@deprecated`, behaviour-identical;
  routes keep using them until the cutover.

## 5. Defects found in the `handoff` bundle (fixed / to fix at cutover)
1. **Migration number `042` collides** — `042_operation_events_append_only_trigger.sql` already exists (prod
   version 42). The backfill must be **054/055**, not 042.
2. **`UNIQUE(user_id, app_id)` grain** — `ON CONFLICT (user_id, app_id)` creates 4 rows for 11 memberships;
   the lockout-check's own gate (`entitlements == active_members`) would fail. Fixed by the per-workspace grain
   decision (§4): `UNIQUE(user_id, workspace_id, app_id)` + `ON CONFLICT (user_id, workspace_id, app_id)` → 11
   rows.
3. **APPLY-MANIFEST over-claims no-lockout parity** without modelling multi-workspace users; `granted_by →
   owner_user_id` assumes a valid workspace owner — verify before apply.

## 5b. Cutover WIRED behind a default-OFF flag (260708) — production authority still UNCHANGED
The 12 governed write-gates (operational-spine ×9, mcp-gateway ×3) now call `authorizeSpineWrite(ctx, action)`
(`src/workers/lib/spine-authority.ts`) instead of the inline `canWrite(role)`:
- **`ENTITLEMENT_ENFORCEMENT` off (default):** `authorizeSpineWrite` returns EXACTLY `canWrite(role)` — no DB
  read, byte-identical 403s. Proven by `spine-authority.test.ts` (all roles, no getOperatingMode/resolvePrincipal
  call) AND by the unchanged `operational-spine-route.test.ts` / `mcp-gateway-route.test.ts` (56 tests, still green).
- **`ENTITLEMENT_ENFORCEMENT='on'` (operator flips it):** authority = entitlement + mode + action via
  `canActOnSpine(resolvePrincipal(...))`. Operating mode is read SERVER-SIDE (`dal.getOperatingMode`, migration
  052) — never client-asserted. Proven by `spine-authority.test.ts` + `operator-axis-route-contract.test.ts`.
- **`buildPrincipal` (session.ts) is UNCHANGED** — the session principal is still role-derived, so the gap-lock
  (`entitlement-source-gap.test.ts`) stays passing. Enforcement flows only through `authorizeSpineWrite` when
  the flag is on.

**TO FLIP (operator-named — this is the moment production authority becomes entitlement-backed):** set the
worker var in the Cloudflare dashboard → `xlooop-api` → Settings → Variables → add `ENTITLEMENT_ENFORCEMENT` =
`on` (persists across deploys via keep_vars; no code change). Staging-verify first: owner/operator perform a
governed write, viewer/client denied — identical to pre-flip (the backfill preserves today's authority). To
revert: set it back to `off` (or delete the var). Then curate entitlements to least-privilege (the real win).

> ⚠️ **DO NOT FLIP until every pre-flip gate in §5c is GREEN.** The flag alone is not the gate — the flip
> re-derives authority from two DB axes (entitlement + operating mode) for HUMAN users, and a third path
> (service tokens) that neither backfill touches. Flipping before all three are settled = write lockout.

## 5g. Flip sequencing + probe discipline (P4 — adopted from external review 260708)
1. **Deploy → soak → flip, NEVER bundled.** Deploy the code flag-OFF as its own step; confirm on the DEPLOYED
   build (`/health .build == <sha>`, zero-5xx, §5c gates still 0/0/0 read against prod), let it soak. Only then
   flip. Bundling the deploy with the flip makes any post-flip regression un-attributable (new code vs.
   enforcement change).
2. **The probe MUST exercise the DB-role ≠ JWT-role axis** (the class that produced the P5(b) MAJOR). Owner→200
   / viewer→403 validates only the aligned axes. If constructible, include a **DB-owner / JWT-viewer** actor
   (workspace_members.role='owner' but Clerk org role maps to viewer) and its inverse. Note the real semantics:
   for that actor, flag-OFF `canWrite(viewer)` DENIES, flag-ON entitlement-backed ALLOWS — so the flip CHANGES
   their result (denied→allowed, correctly: the DB membership is the truth). The flip is NOT purely
   result-preserving for role-mismatched users; the probe must cover them.
3. **Frame the flip honestly: it is a MECHANISM cutover on a deliberately-broad grant, not a lockdown.** The
   055/P5(a) role-mirror grants nearly everyone operator-grade, so `ENTITLEMENT_ENFORCEMENT=on` changes the
   enforcement SOURCE (role → entitlement) while mostly preserving the RESULT. The real least-privilege win is
   **P5(c) curation** (tightening the broad grant), which is deferred and operator-owned. Do not oversell the
   flip as "locking things down."
4. **P5(a) provisioning writer is ACTIVE flag-off — a named DB side-effect, not "byte-identical".** The writer
   (`member-authority-provisioning.ts`) is NOT flag-gated: from the moment its build is deployed, member
   lifecycle events (role-change, provisioning, workspace-create, session-bootstrap) WRITE `customer_entitlements`
   + `user_session_preferences` rows (pre-staging the flip so new members never lock out). **Flag-off AUTHORITY
   is byte-identical** (governed writes still use `canWrite(role)`, which reads neither table). But the DB
   side-effects are real: `customer_entitlements` gains rows (read by nothing flag-off — `resolvePrincipal` runs
   only flag-on), and `user_session_preferences` gains operator-mode rows (surfaced in `GET /session`
   `identity.operating_mode`; the old UI reads `default_operating_context` and P6 consumes it only flag-on, so
   no behaviour change — but it IS a data + response-shape change). Name this when deploying; it is intentional
   (continuous §5e closure), not inert.
   - **P5(c) interaction to design for:** the writer upserts the ROLE-MIRROR grant on every role-change. Once
     curation (P5(c)) tightens a member below role-mirror, a later role-change would RE-BROADEN them. The
     provisioning writer must consult the curated policy (not hard-coded role-mirror) once P5(c) exists.

## 5c. The pre-flip lockout gates (MANDATORY — ground-truth-verified against prod + source 260708)
Flipping `ENTITLEMENT_ENFORCEMENT=on` makes `authorizeSpineWrite` require **entitlement AND operator-mode**
(`canActOnSpine`) for a human user. Each is read from a per-(user, workspace) row; a missing row denies. Three
independent lockout vectors, verified:

| Gate | Axis | Read from | Prod state (verified 260708) | Fix |
|---|---|---|---|---|
| **Gate 0 — empty entitlement** | AppEntitlement | `customer_entitlements` (via `resolvePrincipal`, `app_id='xlooop-product'`) | ✅ **GREEN — 11 rows, per-key parity clean** (0 members missing, 0 orphans). 054/055 **APPLIED** (verified 260708). | done |
| **Gate 1 — watch-default** | OperatingMode | `user_session_preferences` (via `dal.getOperatingMode`) | ✅ **GREEN — 056 APPLIED** (verified 260708: schema head 56; operator-mode rows 11/11 == active owner/operator; per-key anti-join 0). | done |
| **Gate 2 — service writers** | (exempt) | n/a | ✅ **CLOSED in code** — `canary_lifecycle` + `customer_token` (`svc_*` ids, no entitlement/mode row) are exempt: `authorizeSpineWrite` returns the legacy role gate for any `auth.service_principal`, narrowed by the downstream scope guard (`ensureCanaryLifecycleWrite` / `ensureCustomerWriteScope`). | done (spine-authority.ts) |

**ALL THREE GATES ARE GREEN (260708)** — the flip is unblocked pending the §5g probe + operator naming.
Historical note (why Gate 1 was the one most likely to bite, per the frontend team): even with 055 granting
every member an operator-capable *entitlement*, their *session mode* stayed the default `'watch'` until 056 —
the two human axes are AND-ed. viewer/client are correctly denied on both and
are NOT seeded. **Gate 2 was NOT on the original gate list** — it is the third lockout vector the frontend team
surfaced; it is fixed in code (a data-seed would pollute `customer_entitlements` with non-member `svc_*` rows
and break Gate 0's per-key parity, so the exemption lives in the gate, not the table).

**Pre-flip GREEN check — per-KEY parity, not count==count (run against prod read-only; all must hold):**
```sql
-- Gate 0: EVERY active membership has a live entitlement at its (user, workspace) — and no orphans.
SELECT
  (SELECT count(*) FROM workspace_members wm WHERE wm.status='active'
     AND NOT EXISTS (SELECT 1 FROM customer_entitlements ce
        WHERE ce.user_id=wm.user_id AND ce.workspace_id=wm.workspace_id AND ce.revoked_at IS NULL)) AS members_missing_entitlement,  -- expect 0
  (SELECT count(*) FROM customer_entitlements ce WHERE ce.revoked_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM workspace_members wm
        WHERE wm.user_id=ce.user_id AND wm.workspace_id=ce.workspace_id AND wm.status='active')) AS orphan_entitlements;          -- expect 0
-- Gate 1: EVERY active owner/operator membership has operator session-mode at its (user, workspace).
SELECT count(*) AS owner_operators_missing_operator_mode
FROM workspace_members wm
WHERE wm.status='active' AND wm.role IN ('owner','operator')
  AND NOT EXISTS (SELECT 1 FROM user_session_preferences usp
     WHERE usp.user_id=wm.user_id AND usp.workspace_id=wm.workspace_id AND usp.operating_mode='operator');                          -- expect 0
```
Count==count (`11==11`) is necessary but NOT sufficient — it can pass while a specific (user, workspace) is
under-provisioned and another is duplicated. The anti-join above proves per-KEY parity. Prod is multi-workspace
(11 memberships / 4 users), so this matters. Then staging-verify with a REAL owner JWT (template
`xlooop-workers`): an owner performs a governed write (not 403) and a viewer is denied (403) BEFORE setting the
var. This live write/deny probe is MANDATORY — do not skip it. If any gate is red, the flip is unsafe.

## 5d. The client-only mode toggle — ACCEPTED INTERIM divergence (verified 260708)
The old app.xlooop UI's operating-mode toggle is **client-only**: `useXcpMode.js` / `setXcpMode` write
`localStorage['xcp.cockpit.mode']` + broadcast a `cockpit-mode-changed` window event; **nothing calls
`PATCH /api/v1/session/mode`**. `AuthProvider` reads `operating_mode` from `default_operating_context` one-way
at load. So the authoritative server mode (`user_session_preferences`, which 056 seeds to `operator`) and the
visible UI mode can diverge: post-flip, a user who sets the visible toggle to "Watch" (believing they are
read-only) is still `operator` server-side and can still write. That is a safety-relevant UX inconsistency, not
cosmetic, because the whole cutover premise is "mode gates writes."

**This is the only no-lockout option for the interim** (seed-operator + client-toggle) and is ACCEPTED as such
until the toggle is wired. **Sequencing dependency:** wiring the toggle to `PATCH /api/v1/session/mode` (using
the `xlooop-workers` Clerk template) must ship BEFORE re-seeding 056 to `watch` (deliberate-operator UX) — do
it in the other order and you reintroduce the Gate-1 lockout. Until the toggle persists, keep 056 seeding
`operator`. Old-frontend adapter work is a separate, operator-scoped task; it is NOT a blocker for a
carefully-communicated flip, but it IS a blocker for the "watch is truly read-only" guarantee.

**Migration numbering (purpose only):** 053 = model-runtimes encryption (Wave C); 054 = entitlement grain
`UNIQUE(user_id, workspace_id, app_id)`; 055 = entitlement role-mirror backfill; 056 = session-mode seed;
057 = tool_events↔spine link (W1); 058 = chat receipt grounding (W1); 059 = document_access_log (W4);
060 = customer_entitlements lifecycle columns expires_at/review_due (U1).

<!-- APPLIED-STATE-SSOT-BEGIN (verify:migration-state-ssot — the ONLY place current migration state may be stated undated) -->
**APPLIED-STATE SSOT (anti-drift rule — F1/F14 recurred here twice).** Whether a migration is APPLIED is a
PROD fact, not a repo fact — the ONE source of truth is prod `schema_head`. **Do NOT restate per-migration
APPLIED/STAGED in prose anywhere else in this doc** (that is exactly what drifted — "056 staged" lingered in
≥2 places after apply). Verify on demand:
`SELECT max(version) FROM workers_schema_version;` against prod Neon (`flat-truth-23350426`).
As-of snapshot (live-verified 260710, schema head **61**): **054–061 APPLIED** (057–061 applied 260710 to prod, operator-named; row counts byte-invariant — 5426 events / 11 entitlements / 76 chat / 88 tool, zero backfill; RLS enabled+policied on the two new tables `document_access_log` + `feedback`). No migration STAGED.
An external report citing "056 staged / Gate-1 RED / 0 session-pref rows" read a pre-apply tip (444d89c3), not
the live DB — reconcile against `schema_head`, never against a doc line.

**C1 dry-run evidence (260709, Design-greenlit, §164 con C1 CLOSED):** the four staged migrations were
replayed in order against a throwaway Neon branch of PROD (`dryrun-057-060-260709`, deleted after): schema
head 56→60 · the 041-recipe CHECK drop/re-add on `operation_events.source_tool` validated all **5,395**
prod-shaped rows (live values github/xlooop/operator/claude all within the new list) · every new
object/index present (`tool_events.event_id`, both `chat_messages` receipt columns + GIN/unique partial
indexes, `document_access_log` with RLS enabled, both entitlement lifecycle columns + partial index) ·
version-guard re-apply no-ops (head stays 60, 4 guard rows exactly) · row counts byte-invariant
(11 entitlements / 11 operator-mode / 5395 events / 76 chat / 88 tool; zero backfill by design) · prod
default branch re-read after teardown: head 56 (untouched). The prod apply itself remains OPERATOR-NAMED.

**C1-ext dry-run evidence (260710, operator-named "Neon dry-run of 061"):** the T6 migration **061** was
proven alongside 057-060 by replaying all FIVE staged migrations in order against a fresh throwaway Neon
branch of PROD (`dryrun-061-260710` / `br-lucky-band-a71gs1jz`, auto-expiry set, deleted after): branch
started at head **56** (matches prod SSOT) with `xlooop_rls_workspace_id` present → after replay head **61**
· all objects present (057 `tool_events.event_id` + CHECK carries `tool_action`; 058 both `chat_messages`
receipt cols; 059 `document_access_log`; 060 both entitlement cols; **061 `feedback` table**) · RLS enabled
+ policied on BOTH new tables (`document_access_log`, `feedback`) · 061 version-guard re-apply = no-op ·
functional smoke: insert defaults correct (status `open`, mode `test`), both CHECK constraints present
(`body ≤ 2000`, status enum) · prod default branch head after teardown: **56 (untouched)**. The prod apply
of 057-061 remains OPERATOR-NAMED.
<!-- APPLIED-STATE-SSOT-END -->

## 5e. Post-flip durability caveats (adversarial-verify 260708 — accept, then close)
The gate work makes the flip safe for the members who exist AT flip time. Two divergences persist AFTER the
flip that flag-off never had — neither blocks the flip for today's 11 members, but both must be owned:
1. **New-member provisioning gap (the one to close next).** 055/056 are ONE-SHOT, version-guarded backfills over
   `status='active'` at apply time. A member promoted to owner/operator (or newly activated) AFTER the flip gets
   NO `customer_entitlements` row and NO `user_session_preferences` mode → `missing_entitlement` / `watch` deny →
   403, even though flag-off they would `canWrite`. There is NO standing entitlement/mode PROVISIONING writer
   (`entitlement-store.ts` is read-only by design). **Required before the flip is left on long-term:** a
   provisioning path that inserts a default entitlement + operator-or-watch mode on member add/promote (this is
   the same entitlement-lifecycle layer as least-privilege curation). Until it exists, treat "add/promote a
   member" as also requiring a manual entitlement+mode insert. STOP-condition: do not onboard a new
   owner/operator post-flip without provisioning their rows.
2. **Availability coupling (accepted).** Flag-on adds two DB reads (mode + entitlement) to every human governed
   write; both fail CLOSED (a transient read error denies). That is the correct security posture, but flag-off
   did no DB read and could not fail this way — so the flip couples governed-write availability to those reads.
   Accepted (fail-closed > fail-open); the `wrangler rollback`-free revert (`ENTITLEMENT_ENFORCEMENT=off`)
   restores the no-DB-read path instantly if it ever bites.

## 5f. Affordance == enforcement — the honest-flip projection (B1, 260708)
The flip makes the SERVER decide governed writes by mode + entitlement. If the UI still decides a control's
enabled/disabled state its own way (role, or the client-side mode), the two disagree: post-flip a user in Watch
sees an ENABLED "submit" that the server 403s — an "enabled → 403" lie (the same class as the F12 dead editor,
and the read-side twin of the client-only-toggle "Watch lies" in §5d).

**Fix:** `spine-authority.ts` now has ONE decision core (`canActOnSpine` via the shared resolve) with TWO
consumers — `authorizeSpineWrite` (ENFORCE, the 12 write gates) and `projectSpineAuthority` (PROJECT, the read
side). GET `/session` returns a `spine_authority` envelope in the `identity` block:
`{ allowed_actions: SpineAction[], disabled_reasons: {action: reason}, enforced: boolean }` — the SAME verdict
the write gate will return, per action, mode-aware. The UI enables a spine-write control iff its action is in
`allowed_actions`, and renders `disabled_reasons[action]` as the "why" (the §138 "why am I allowed/denied?"
surface reads server truth instead of mirroring it client-side). `enforced` tells the UI whether mode is
authority-bearing yet (false pre-flip). This is the backend half of the frontend's rec-2; the old app consumes
it in place of client-mode gating.

- **Flag-off:** the projection returns `canWrite(role)` for every action (action-blind), matching the legacy
  gate exactly — byte-identical today, `enforced:false`.
- **Consistency gate:** `spine-authority.test.ts` asserts `projectSpineAuthority` allow(action) ===
  `authorizeSpineWrite(action).allowed` for EVERY action — affordance and enforcement cannot drift.
- **Seeded proof:** `spine-authority-seeded.test.ts` drives the flag-on path through the REAL
  `resolvePrincipal`/`getAppEntitlementRow` (only the Sql driver mocked): owner-with-entitlement writes,
  viewer-without denied, watch-mode blocked — the "flag-on e2e on a seeded DB" the dev team asked for.

## 6. What shipped in Wave OA-SAFE (INERT — commit on main, nothing wired to prod)
- `dal/entitlement-store.ts` — `getAppEntitlementRow(sql, userId, workspaceId)` (per-workspace, fail-closed,
  degrade-safe) + `toAppEntitlement` mapper.
- `dal/principal-hydration.ts` — `resolvePrincipal` / `buildPrincipalFromAuthContext` (real-entitlement or
  fail-closed) + `buildDemoPrincipalFromRole` (throws unless an explicit dev flag). NOT called anywhere.
- `lib/permissions.ts` — `canActOnSpine(principal, appId, mode, action)` (entitlement + mode + action;
  deny-wins; operator-required; fail-closed). `canWrite`/`isOperatorRole` `@deprecated`.
- Tests: `permissions-operator-axis` (12-case), `entitlement-hydration` (fail-closed + no-lockout parity +
  deny-wins + revocation + dev-fallback), `entitlement-source-gap` (gap-lock — PASSING == gap exists),
  `operator-axis-route-contract` (describe.skip — cutover plumbing).

## 7. The staged no-lockout cutover (operator-gated)
1. ✅ Migration **054** — `customer_entitlements` → `UNIQUE(user_id, workspace_id, app_id)`. **APPLIED to prod** (verified 260708:
   schema head 55). Was local-PG-validated before apply (safe: 0 rows at apply time).
2. ✅ Migration **055** — per-workspace role-mirror backfill (`ON CONFLICT (user_id, workspace_id, app_id)`),
   one row per active membership. **APPLIED to prod** (verified 260708: 11 rows, per-KEY anti-join clean —
   0 members missing, 0 orphans). Local-PG-validated before apply: a multi-workspace user correctly gets one
   row PER workspace (the grain proof); owner/operator→operator-mode, viewer→watch, client→denied `['*']`;
   suspended excluded; idempotent ×2. **Gate 0 GREEN.**
3. ✅ Migration **056** — `user_session_preferences` seed `operating_mode='operator'` for active owner/operator
   memberships (`ON CONFLICT (user_id, workspace_id) DO NOTHING` — never clobbers a user's own mode).
   **APPLIED to prod** (operator-authorized, verified 260708: schema head 56; operator-mode rows == active
   owner/operator == 11/11; §5c per-key anti-joins 0/0/0 re-verified post-deploy). Was local-PG-validated
   before apply (viewer/suspended NOT seeded; an explicit `watch` survives re-apply). **Gate 1 GREEN.**
4. ✅ Reader + gate wired behind the default-OFF `ENTITLEMENT_ENFORCEMENT` flag (§5b): the 12 spine/mcp
   `canWrite` sites now call `authorizeSpineWrite` → `resolvePrincipal` + `canActOnSpine` when the flag is on;
   byte-identical legacy `canWrite` when off. `buildPrincipal` unchanged, so `entitlement-source-gap.test.ts`
   stays passing. Proven by `spine-authority.test.ts` + `operator-axis-route-contract.test.ts`.
5. Staging-verify (AFTER applying 054+055+056, BEFORE the flip): §5c pre-flip GREEN check (both gates 11==11) +
   an owner/operator performs a governed write and a viewer/client is denied — identical to pre-flip.
6. **Flip** `ENTITLEMENT_ENFORCEMENT=on` (operator-named, §5b). Then **curate** entitlements to real
   least-privilege — the actual security win — as a reversible, per-customer data operation.

## 8. Stop conditions
Stop + report if: the backfill would create a row count ≠ active memberships; any real user would be denied a
write they can perform today; `granted_by` has no valid owner; a grant-policy (curation) decision is needed
from Marat; a migration needs broad destructive data mutation; new-frontend code would be touched.

## 9. STAGE-0 handoff preflight (MANDATORY for any executed handoff prompt/bundle)
Recurring failure class (seen ≥3×, incl. the dev team's own stale-checkout mis-call): a handoff prompt is
executed or assessed against a premise the repo/prod no longer matches, producing rebuild-what-exists work or
false "nothing landed" verdicts. Before EXECUTING or ASSESSING any handoff artifact, produce and print this
table from FRESH reads (never from memory/summary/the artifact's own claims), and reconcile any mismatch
BEFORE proceeding:

| Check | How | Abort/reconcile if |
|---|---|---|
| Repo tip | `git rev-parse HEAD` + `git ls-remote origin main` | artifact assumes a different tip |
| Tree state | `git status --short` | dirty when artifact assumes clean |
| Schema head | `SELECT max(version) FROM workers_schema_version` (prod, read-only) | artifact assumes different migrations applied |
| Flag state | worker vars (e.g. `ENTITLEMENT_ENFORCEMENT`) via config/dashboard | artifact assumes a different flag state |
| Claimed files/systems | `ls`/`rg` the artifact's load-bearing file claims | artifact says "missing" for something present (or vice versa) — the extend-not-rebuild check |
| Deployed build | `GET /api/v1/health` `.build` (cache-busted) | artifact assumes a different live build |

A mismatch is not a blocker — it is a RECONCILE step: correct the artifact's premise, then execute the
corrected intent. Sibling rule (ecosystem): MB-P `HR-STALE-INTAKE-PREFLIGHT-1`.
