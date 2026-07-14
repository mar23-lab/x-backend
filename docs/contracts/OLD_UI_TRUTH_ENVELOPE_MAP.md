# Old-UI ⇄ response-truth-envelope consumption map (A-W2 · 2026-07-07)

How the existing (old) UI consumes the server response-truth envelope — `data_class` (M3),
`allowed_actions`/`disabled_reasons` (M4), per-document `admissibility` (M6). The goal is to make the
**old UI a proper contract-consumer** so the future new UI can swap in route-by-route against the SAME
contracts. **The new UI is NOT implemented here** — this is preparation only.

**Single reader:** `src/shared/services/api-client/envelope.ts` — `extractDataClass`, `isLiveData`,
`extractAllowedActions`, `isActionAllowed(resp, action, fallback)`, `disabledReasonFor`,
`isAdmissibleForContext`. Authority + data-labelling stay **server-derived** (ACCESS_CONTROL_MATRIX.md
invariant #1); the UI never re-computes them. `isActionAllowed`'s `fallback` param preserves the old UI's
prior role-based behaviour with zero regression when a response is unenveloped during rollout.

## Semantics (important)
- **`data_class` is per-RESPONSE** (the whole list is live|starter|template|redacted|public_safe) → its
  badge belongs at the **list/container** level, NOT per row.
- **`admissibility` is per-DOCUMENT-row** → its control belongs on document rows only.
- **`allowed_actions`/`disabled_reasons` are per-RESOURCE for the caller** → drive control enable/disable.

## Consumption status (screen × route × field × gap)

| Surface | Route | data_class | allowed_actions | admissibility | Status / gap |
|---|---|---|---|---|---|
| `useProjectEvents` hook | GET /projects/:id/events | ✅ exposes `dataClass` (A-W2a) | — | — | consumer wired; container render = A-W2b |
| `useProjects` hook | GET /projects | 🔴 via repository (indirection) | 🔴 | — | A-W2b: surface `dataClass`/`allowed_actions` through the repo adapter |
| `EventRow` primitive | (rendered by boards) | n/a (per-response) | — | — | not the right level for data_class |
| `InlineEventsBoard` | events board | 🔴 | — | — | A-W2b: render one `DataClassBadge` at board header |
| `WorkspaceShellCockpit` | GET /projects | 🔴 | 🔴 | — | A-W2b: badge + action gating from server |
| `MinimalUserShell` (live chat home) | mixed | 🔴 | 🔴 | — | A-W2b |
| Document surfaces | GET /documents | 🔴 | — | 🔴 per-row | A-W2b: admissibility control + PATCH /documents/:id/admissibility |
| `iam.ts` (mode/role vocab) | — | — | ⚪ KEEP as-is | — | **NOT migrated** — parity-pinned mode vocab (watch/test/operator = session write-posture presentation), not per-resource authority. Corrected A-W2b below. |

## Corrected A-W2b design (grounded)
`iam.ts` STAYS — it is the parity-pinned role/mode/surface vocabulary (a session write-posture presentation
layer), NOT per-resource authority. The migration is SURGICAL per-widget: at each control's enable/disable
site, gate on `isActionAllowed(resp, '<action>', roleFallback)` where `resp` is the resource response
carrying M4 `allowed_actions`. Server = authority; the existing role check = `roleFallback` (so an
unenveloped response keeps today's behaviour → zero regression). Precondition per widget: plumb
`allowed_actions` through its hook (the same additive pattern as `dataClass` in `useProjectEvents`).
Prove the gate logic with a unit test (server-allow→enabled · server-deny→disabled · absent→role-fallback)
so the deny path is verified without an authenticated preview; then land per-role preview verification.

### Client-derived-authority hotspots (per-widget augmentation targets)
`DetailedWorkspaceShellDesign.jsx` (`ws.myRole === 'owner'`) · `SyntheticDomainsPanel.jsx`
(`role === 'owner'|'operator'`) · `DesignFrame.jsx` (create-workspace gate) ·
`DetailedProjectShellDesign/project-scope-config.jsx` (operator gate) · `AdminMenu.jsx` (`isOwner`) ·
`CockpitTopBarActions.jsx`. Each augmented, not rewritten.

## A-W2d LANDED (targets 1+2) — first widgets consume server authority
- **Target 1 · SyntheticDomainsPanel** (7a75a325): `canEdit` = `isActionAllowed(envelope, 'edit',
  roleFallback)`; `fetchDomains` keeps `{rows, allowed_actions, disabled_reasons}`. Verified preview
  fail-closed + no console errors.
- **Target 2 · DetailedWorkspaceShellDesign project-source seam** (62127857): `projectSourceDisabledReasonDWS(psEnv)`
  = `isActionAllowedDWS(psEnv, 'disconnect', isOwner)` + server disabled_reason; the /sources envelope kept
  in `projectSourceBindingsDWS`. Ceiling-safe (2082/2085).

## A-W2e / A-W2f LANDED (260707) — governed mutating controls now consume server authority
The `verify:old-ui-consumes-envelope` REQUIRED_CONSUMERS manifest is now **7 entries** (gate-frozen):
- **A-W2e · CockpitTopBarNotifications** (27ff5660): one-tap governed approve gated on the `/events` envelope
  `isActionAllowed(b, 'status_repoint', true)`; disabled + server reason when withheld (no dishonest button).
- **A-W2e · LiveStreamRailV3 `_shared/rail-body.jsx`** (d2abf4c5): the rail sources rows from the client
  stream plane (no envelope in its data path), so it gates on a shared `useEventsAuthority` probe of
  `GET /events?limit=1`. Valid sign-off targets a caller may not action render disabled+reason; non-targets
  stay hidden. *Retro fix (F15): the probe now re-fires on `xcp:api-client-status` so cold-mount gating isn't inert.*
- **A-W2e · `useEventsAuthority` hook** (d2abf4c5): the shared server-authority probe (module-cached, degrade-safe,
  `window.React`-sourced for the shell-widgets IIFE).
- **A-W2f · SettingsScreen owner-only member role editor** (ac99a35c; **F12-fixed 260707**): inline role
  `<select>` per member gated on `isActionAllowed(membersEnvelope, 'role_change', false)`. *Retro fix (F12):
  `GET /members` now derives the `role_change` grant from `operatorOwnsWorkspace` (the SAME predicate the
  PATCH enforces) via `withAuthority(..., { grant:['role_change'] })` — the pure matrix's `R.ownerOnly` could
  never fire (no AuthContext ever has role `'owner'`), so the editor previously rendered for nobody.*

Redaction-aware principal exposure (A-W4.1) also LANDED (b7dc06da): `authorized_by_user_id` exposed to
accountable roles, fail-closed-redacted for `client`/`viewer`/unknown. Remaining 🔴 surfaces (unchanged):
`useProjects` repo indirection, InlineEventsBoard, WorkspaceShellCockpit, MinimalUserShell, document admissibility control.

## A-W2d TARGET 3 (RE-ASSESSED 260707 — DE-PRIORITIZED to low-impact polish)
Grounding overturned the initial "security fix" framing: the DWS workspace-mutation controls are gated
server-side by **operator IDENTITY** (`PATCH`/`DELETE /workspaces/:id` → `operatorIds` = MBP_OWNER_USER_ID),
NOT workspace role; and GET /workspaces (the live-workspaces-hydrator source) is operator-identity-only too,
so `window.SPACES` only DB-hydrates for the platform operator → DWS is effectively an OPERATOR-ONLY surface.
The hardcoded `myRole:'owner'` (buildWorkspace.js:79) is thus correct for its only real user, and a customer
cannot mutate workspaces regardless (server 403). The "Only the workspace owner can…" UI copy is imprecise
(the real gate is operator-identity). Net: false-affordance risk is minimal, server enforces. Deferred as
cosmetic polish (correct the copy + optionally reflect real role) — NOT a commercial-readiness blocker.

## A-W2d TARGET 3 (original framing — superseded by the re-assessment above) · the F9 false-affordance fix
`buildWorkspace.js:79` hardcodes `myRole:'owner'` → a viewer sees owner controls (GAP-004 class). BUT the
naive fix (real role) breaks OPERATORS: DWS `isOwner = ws.myRole === 'owner'` (:298) is used in ~10
workspace/project controls that are actually **owner-OR-operator** per the matrix — an operator would lose
them. Correct fix needs: (a) resolve each control's owner-only vs owner-operator rule; (b) source the real
role (customer path: GET /workspaces is operator-only 403s — customer role comes from session/profile, not
that list; operator path: the workspaces envelope); (c) DWS headroom is 3 lines → extract to `_shared/`.
Do as a focused pass. Server prerequisite (workspace + project envelopes) already live (A-W2c).

## A-W2c LANDED (260707) — backend M4 coverage extension
MATRIX now carries 10 kinds (+`workspace`, +`synthetic_domain`); `withAuthority` adopted on 7 more routes:
workspaces list / :id/activity-summary / :id/plan / :id/projects (project-kind parity), synthetic-domains
list / :id, members list. F10 fixed: `GET /members` now 403s the client role (matrix↔code drift closed).
The widget targets' server prerequisite is DONE — A-W2d (SyntheticDomainsPanel seam, DWS project_source
seam, then DWS workspace-plane + the F9 `myRole:'owner'` hardcode fix) is unblocked once this is deployed.

## Sequencing insight (grounded) — the migration has TWO fronts
Frontend widget authority-migration is **gated on backend M4 coverage** of that widget's resource. M4
`allowed_actions` is currently adopted on **projects / events / sources** only. Therefore:
- Widgets gating **project/event/source** actions CAN migrate now (allowed_actions available). The one live
  consumer of event allowed_actions is `DetailedProjectShellDesign.jsx` (2000+ LOC, indirect mode-lock
  gating) → higher-effort surgery.
- Widgets gating **workspace/domain/member/admin** actions (SyntheticDomainsPanel, DetailedWorkspaceShellDesign,
  AdminMenu) canNOT meaningfully migrate until the backend adopts `withAuthority` on those responses — until
  then `isActionAllowed` always hits the role-fallback (inert).
- **Recommended order:** extend backend M4 (`withAuthority`) to workspaces/synthetic-domains/members FIRST
  (small, safe, server-side, its own gate) → then the simple widgets migrate mechanically with the
  test-proven `isActionAllowed(resp, action, roleFallback)` helper. Prefer this over big-file surgery.

The authority primitive itself is test-proven: `src/shared/services/api-client/envelope.test.ts`
(`verify:envelope-reader`) — server-allow→enabled · server-deny→disabled · absent→role-fallback.

## Swap-readiness rule
No control is enabled unless the server allows it; starter/template/public-safe data is never shown as the
customer's live records; disabled controls show the server's `disabled_reasons`. When the new UI arrives it
consumes the SAME `envelope.ts` reader — no backend rework.
