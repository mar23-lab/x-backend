# ADR-V3-010 · StoreAdapter shim

**Status:** Accepted 2026-05-04 (T1-C landed in 5fd566b; T1-H.H2 added getInitialState seam; consumers route through StoreAdapter for session/policy/store/initial-state)
**Date:** 2026-05-03
**Decision-makers:** Marat
**Cross-link:** [ADR-V3-002](ADR-V3-002-dal-adapters.md), [ADR-V3-007](ADR-V3-007-foundation-first-sequencing.md), [ADR-V3-009](ADR-V3-009-eventbus-topic-registry.md), x-front `src/shared/services/storeAdapter/` (audit 2026-05-03 → 9/10)

## Context

v3 today has four parallel state surfaces:
1. `useReducer` per-project state (`store[projectId]`)
2. `window.policy` (Phase 6 merged policy)
3. `window.session` (planned for Phase 5)
4. Multiple `localStorage` keys (`LS_KEY`, `LS_NAV`, `LS_PERSONAL`, `LS_TWEAKS`)

Each has its own access pattern. RTK adoption later (per ADR-V3-002 DAL roadmap) has to migrate all four. Phase 5 introduces a session and an EventBus PersistAdapter — surfaces #5 and #6 — without a unified seam.

x-front (audit 2026-05-03) ships a sophisticated StoreAdapter pattern: `IStoreAdapterFacade` interface + 3 implementations (`UIStoreAdapter`, `CompilerStoreAdapter`, `CodebaseStoreAdapter`) with read/write port separation (CQRS-ish). Consumers use `useStoreAdapter()` hook; bypass paths are rare and documented. Score 9/10.

## Decision

**v3 ships a StoreAdapter shim from T1-C — same shape as x-front's, in-memory wrapper today, RTK selectors tomorrow.**

### API surface
```ts
// shared/services/storeAdapter
interface IStoreAdapter {
  // session
  getSession(): Session | null
  setSession(s: Session | null): void
  useSession(): Session | null

  // policy
  getPolicy(): Policy | null
  usePolicy(): Policy | null

  // project store (per-project state, current useReducer-backed)
  getProjectState(projectId: string): ProjectState | null
  useProjectState(projectId: string): ProjectState | null
  dispatchToProject(projectId: string, action: Action): void

  // event bus subscriptions (delegated to ADR-V3-009 EventBus)
  subscribe<T extends EventTopic>(topic: T, h: Handler<T>): SubscriptionToken
  publish<T extends EventTopic>(topic: T, payload: PayloadFor<T>): void
}
```

### Today's implementation
- `getSession`/`setSession` wrap `window.session` + `Object.freeze` (or `Object.preventExtensions` if React DevTools collide per Section 5 stop condition).
- `getPolicy`/`usePolicy` wrap `window.policy` (already merged at boot).
- `getProjectState`/`useProjectState`/`dispatchToProject` wrap the existing `useReducer` from `app.jsx`.
- `subscribe`/`publish` delegate directly to `eventbus.jsx`.

### Tomorrow's swap (post-RTK adoption)
- `setSession` dispatches `sessionSlice.actions.set`.
- `useSession` reads `useSelector(selectSession)`.
- `dispatchToProject` is `useDispatch()`.
- All consumers unchanged.

### Bypass discipline
**No code outside `shared/services/storeAdapter/` may directly access `window.session`, `window.policy`, or `localStorage.LS_*` keys.**
- smoke-cli regex check: `window\.(session|policy)` should appear only in `shared/services/storeAdapter/` and in `data.jsx` (the boot-time setter).
- Direct `localStorage.getItem('LS_*')` permitted only in `shared/services/storeAdapter/persist-bridge.jsx` and `data.jsx`.

**Rejected alternative:** "Skip the shim, adopt RTK directly when needed." Rejected because RTK adoption is a non-trivial spike; the shim's purpose is to let consumers stop caring about the migration.

## Consequences

**Positive:**
- Phase 5 (`getSession`, `useSession`) consumes the StoreAdapter API from day one — no inline `window.session` access.
- All four state surfaces converge to one access pattern.
- RTK migration becomes "swap implementation file" not "refactor every consumer."
- AuthProvider (T1-D, ADR-V3-004) plugs into the same shim — `setSession` is the only seam it needs.

**Negative:**
- ~30–60 LOC of indirection added today for value paid out tomorrow.
- One more concept (`StoreAdapter`) for newcomers to internalize.

**Mitigations:**
- Documented at the top of `shared/services/storeAdapter/index.jsx` with a 5-line "what this is, why it exists, when to bypass."
- ddd-glossary.md adds the term.
- Smoke-cli enforces no-bypass.

## Verification

- `v3/project/v3/__contracts__/store-adapter.contract.test.ts` — type-only assertion that the implementation satisfies `IStoreAdapter`.
- smoke-cli: `shared/services/storeAdapter/index.jsx exists`, `IStoreAdapter shape matches contracts`, `no inline window.session/policy in jsx outside storeAdapter`.
- All existing 6 e2e specs pass with consumers reading via `getSession()` / `usePolicy()` accessors instead of inline globals.

## References

- x-front `src/shared/services/storeAdapter/IStoreAdapterFacade.ts` (canonical reference)
- x-front `src/__contracts__/storeShape.contract.test.ts` (port target — T1-F)
- [ADR-V3-002 DAL adapters](ADR-V3-002-dal-adapters.md)
- [ADR-V3-009 EventBus](ADR-V3-009-eventbus-topic-registry.md)
- [plan-foundation-2026-05-03.md](../plan-foundation-2026-05-03.md) §G3
