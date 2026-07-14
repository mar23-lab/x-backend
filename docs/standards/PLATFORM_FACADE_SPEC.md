# Platform Facade Spec (all agents · window-global decoupling)

**Status:** normative. Read this before adding or migrating any `window.Xcp*` /
`window.__xcp*` / `window.Xlooop*` call-site. Linked from
[CLAUDE.md](../../CLAUDE.md). Program background:
[19_WINDOW_GLOBAL_DECOUPLING.md](../frontend-migration/19_WINDOW_GLOBAL_DECOUPLING.md).

## The rule

**New ESM code never reads `window.Xcp*` directly.** It imports from a canonical module
instead. Which module depends on what already exists — check in this order:

1. **A canonical non-window module already exists** (e.g. `runtime/shell-flags.js`,
   `runtime/journey-scope.js`, `runtime/telemetry.js` export pure functions that
   `window.XcpShellFlags`/`XcpJourneyScope`/`XcpTelemetry` merely re-expose for IIFE
   consumption). **Import that module directly.** Do not build a new facade — that would
   create two sources of truth for the same logic.
2. **The global is a singleton instance of a typed class**, constructed once at boot (e.g.
   `window.XcpApi` = one `HttpApiClient` instance built by `runtime/api-client-init.js`).
   **Write a thin typed *accessor*** (`src/shared/platform/api.ts` pattern) that returns
   the existing singleton — never construct a second instance (that duplicates
   session/token state).
3. **No canonical module exists and the global is a simple read/write surface** (e.g.
   `window.XcpClerk`'s `getToken`/`signIn`/`signOut`/`instance`/`status`). **Write a
   graceful facade** in `src/shared/platform/` (the `session.ts` pattern): one function per
   operation, each returns a safe default and never throws when the global is absent.

In all three cases, the facade/accessor/canonical-module lives outside `src/shared/platform/`
only when it already existed elsewhere (case 1) — new facades go in `src/shared/platform/`,
which is the one directory allow-listed to touch `window.*`
(`scripts/verify-no-window-global-coupling.mjs`).

## Migration checklist (mechanical — follow every time)

1. **Find every real call-site** — `grep -rE "window\.<Global>\??\." src` (note the `\??`:
   optional chaining `window.X?.method` does NOT match a plain `\.` pattern; always include
   both). Distinguish real code from doc comments and string literals — read each hit before
   editing.
2. **Confirm the migration doesn't silently change behaviour**: if the call-site had a guard
   (`typeof window !== 'undefined' && window.X && ...`) check whether the target function
   already self-guards (most do — read its source). If it does, the guard boilerplate can be
   dropped, not just the `window.` prefix; if it doesn't, keep an equivalent guard.
3. **Add the import**, migrate the call, remove the dead guard.
4. **Verify, in this order** (never skip a step):
   - `grep` the touched file for the old `window.X` pattern — zero real (non-comment)
     matches remaining.
   - `npm run typecheck:workers` — 0 errors.
   - `node scripts/verify-workspace-component-size.mjs --strict` — no `RATCHET_BREACH` (a
     new import line can push a near-ceiling file over; if so, tag the control inline on an
     existing attribute line instead of a new line, or migrate a different file first).
   - `npm run build:<bundle>` for every bundle that imports the touched file — all `RC=0`.
   - **Browser-verify**: reload the surface in a running preview, check
     `preview_console_logs` for errors, and — if you touched something visually meaningful —
     screenshot it. A clean build does not prove behaviour; only a rendered check does.
5. **Ratchet the gate down**: `node scripts/verify-no-window-global-coupling.mjs
   --update-baseline`. This is what makes the reduction permanent — a regression fails CI
   from here on.
6. **Regenerate the schema + verify integrity** before committing:
   `node scripts/repo-schema-gen.mjs && npm run verify:current-integrity` (expect 64/64).
7. Commit with the **before→after gate numbers** in the message, and what you
   browser-verified. Push (never `--no-verify`); `ci-local` is the release authority.

## Known constraints (don't re-discover these)

- **IIFE-loaded files cannot `import`.** A widget mounted via a raw `<script>` tag (not one
  of the ESM entry bundles) cannot consume a facade — it must keep reading `window.*` until
  the bundle-architecture (IIFE→ESM) refactor lands. Check with `head -25 <file> | grep -E
  "^import |^export "` before attempting a migration.
- **A file at its size ceiling cannot gain a line.** Adding `import { x } from '...'` costs
  one line; if the file is at `ceiling - 0`, either tag inline on an existing attribute line
  (0 growth) or decompose the file first (extract a pure helper to `_shared/`, per
  [FILE_SIZE_STANDARD.md](FILE_SIZE_STANDARD.md)) before migrating its coupling.
- **A "0 matches" or "not found" result after a click/interaction may be a render-timing
  artifact, not a bug.** React state updates commit on the next tick; a `querySelector`
  called synchronously after `.click()` in the same eval can read stale DOM. Await a short
  delay or re-check before concluding something regressed.
- **An unfamiliar UI state (error banner, empty state) may be pre-existing.** Before treating
  it as a regression, `grep` the string in the file and check whether it's present on clean
  `origin/main` (`git show origin/main:<path> | grep '<message>'`). Several apparent
  regressions this program turned out to be verbatim pre-existing behaviour in a
  fixture-only preview (no live backend auth).

## Facades landed so far (reference)

| Facade | Wraps | Pattern |
|---|---|---|
| `src/shared/platform/session.ts` | `window.XcpClerk` | graceful (case 3) |
| `src/shared/platform/api.ts` | `window.XcpApi` | typed singleton accessor (case 2) |
| `src/shared/platform/iam.ts` | (new — no window global) | canonical role/mode/surface SSOT, parity-tested against backend `principal-adapter` |
| `src/shared/platform/workspace-actions.ts` | `window.XcpWorkspaceActions` | graceful (case 3) — over the runtime-populated action surface (create/connect-source/reorder); source stays a classic `<script>` (tenant-copied), so a facade not a dual-purpose module |
| `src/shared/platform/api-auth.ts` | `window.XLOOOP_API_BASE_URL` + `window.XcpClerk` (via `session.ts`) | canonical API auth seam (`apiBaseUrl`/`apiUrl`/`authHeaders`/`apiFetch`) — the ONE place widgets get the Worker API base + authed headers, replacing ~35 duplicated inline `apiBase()`/`authHeaders()` pairs (doc 22 §5 P2). Reachable only by ESM widgets; IIFE widgets still inline until the bundle refactor. |
| `runtime/shell-flags.js` | `window.XcpShellFlags` | pre-existing canonical module (case 1) |
| `runtime/journey-scope.js` | `window.XcpJourneyScope` | pre-existing canonical module (case 1) |
| `runtime/telemetry.js` | `window.XcpTelemetry` | pre-existing canonical module (case 1) |

## Backend-facing counterpart

The same "one canonical seam, typed, tested against real behaviour" discipline applies
backend-side. See
[22_BACKEND_COMPLETENESS.md](../frontend-migration/22_BACKEND_COMPLETENESS.md) for the
endpoint-by-endpoint register and §5 for the prioritized hardening list. When closing a
backend gap that touches the database (a migration, a trigger, an RLS policy):

- **Never apply a migration to production from this workflow** — Neon prod-DB changes are an
  explicit-operator-authorization action class. Write the migration file, review it in
  source, and **validate it for real** against a throwaway local Postgres instance
  (`initdb`/`pg_ctl` — both are present via `brew install postgresql@16`; a scratch instance
  costs ~30s to stand up and must be torn down after) before committing. A migration that
  "looks right" is not verified; one that ran, enforced the invariant, and was proven
  idempotent is.
- Follow the existing migration file's narrative-header convention (WHY with evidence, WHAT
  columns/behaviour, grounded enumeration of every real call-site affected — not a guess) and
  the version-guarded idempotent `DO $$ ... IF EXISTS (SELECT 1 FROM workers_schema_version
  WHERE version = N) THEN RETURN; END IF; ... $$` pattern.
