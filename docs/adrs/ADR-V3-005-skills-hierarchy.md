# ADR-V3-005 · Skills hierarchy — Company / Project / User personal

**Status:** Accepted
**Date:** 2026-05-03
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ADR-V3-004](ADR-V3-004-multi-tenant-identity.md), MB-P `~/WIP/MB-P/_sys/skills/` (idiom reference)

## Context

The v3 demo runs reducer-driven UI; agents (human or LLM) take actions through that reducer. We need a place to record **agentic instructions** — policy that constrains what actions are allowed, what defaults apply, and which surfaces are visible.

Today the policy is implicit (hard-coded in components). We need it explicit, versioned, scoped, and merge-able so:

- A workspace owner sets workspace-wide gates and defaults.
- A project owner can override project-specific gates without touching workspace policy.
- A user can set personal preferences (theme, density, palette shortcuts) without affecting anyone else.
- An agent reads the merged policy and acts within it.

The pattern already exists at MB-P (HR-* governance rules under `~/WIP/MB-P/`). We mirror its idiom.

## Decision

**Three-tier hierarchy with explicit precedence:**

| Tier | Storage | Editable by | Examples |
|---|---|---|---|
| **Company (Workspace)** | `data/workspace.json` per workspace | Workspace owners + admins | Default gates, framework taxonomy, agent-gateway model whitelist, retention policy, visibility defaults, SLA defaults |
| **Project** | `data/projects/<id>/manifest.json` | Project owner + Architect role | Project-specific gate override, runtime binding, AC discipline level, custom decision_record fields, integrations |
| **User personal** | `localStorage.xcp.v3.personal.v1` (already exists in v3) | The user only | Theme, density, palette shortcuts, recently-visited surfaces, notification rules |

**Precedence rules:**

- **Permissions** (what an actor *may* do): most-specific wins. User > Project > Company. Example: Company sets `auto_promote: true`; Project overrides with `auto_promote: false` → effective `false`.
- **Restrictions** (what an actor *must not* do): most-general wins. Company > Project > User. Example: Company sets `require_qa: true`; Project tries `require_qa: false` → effective `true` (Company restriction is binding).
- **Defaults** (what applies absent a setting): User > Project > Company.

**Merge mechanics:**

- Three policy files load at boot via `data.jsx` (post-port).
- Merge produces a **frozen** `window.policy` global.
- Reducer reads from `policy` for permission/restriction checks; never from raw files.
- Agents read from `policy`; agent attestation strip displays which tier each setting came from when relevant.

**Documentation surface:**

- `docs/skills.md` (post-Phase 6.4) lists the policy fields per tier with examples.
- Policy schemas pinned in `contracts/policy-schemas.ts` (post-Phase 2.3).

## Consequences

**Positive:**
- Agents have explicit, scoped instructions — no implicit policy.
- Workspace owners can hand-edit one file to govern all projects.
- Power users get personalisation without affecting team norms.
- Aligns with MB-P's existing HR-* idiom; same mental model.

**Negative:**
- Three files per workspace+project to keep in sync; tooling (or contract tests) must catch drift.
- Initial load adds three JSON parses (negligible).
- Merge logic must handle edge cases (missing tiers, invalid types) — handled by `validators.ts`.

**Out of scope:**
- Backend persistence of policy edits — future work.
- Per-agent policy (an agent has a different policy than the user it acts for) — captured as future ADR if needed.

## Verification

- Phase 6 of roadmap: three policy file shapes implemented; merge function in `runtime/policy.ts`; reducer reads from merged `policy`.
- Contract test in `__contracts__/policy.contract.test.ts` pins the merged shape.
- Storybook story demonstrating the three-file merge.
- Playwright spec: change one tier, observe the reducer respond.

## References

- MB-P `~/WIP/MB-P/_sys/skills/` (HR-* idiom)
- [ADR-V3-004 multi-tenant identity](ADR-V3-004-multi-tenant-identity.md)
- [ddd-glossary.md](../ddd-glossary.md) (will gain a "Skills hierarchy" entry)

## Amendment · 2026-05-04 · Phase 6.3 reducer-side policy gate

The original ADR established the policy data model (workspace + project + personal tier merge into `window.policy`). Phase 6 of the original sequencing landed the data layer (commits `7c3bd4f` + `54d663a`). Phase 6.3 extends this with a **reducer-side gate** that enforces the same policy at the state-mutation seam.

### What landed (commit `7b256d6` · 2026-05-04)

`app/App.jsx::projectStoreReducer` gains a `REDUCER_ACTION_TO_PERMISSION` map and a fail-open guard that runs AFTER the Phase 5B signed-url-readonly guard but BEFORE the project-existence check:

```js
const REDUCER_ACTION_TO_PERMISSION = {
  'approve-wi':         'can_promote_wi',
  'promote-to-signoff': 'can_promote_wi',
  'signoff-wi':         'can_signoff_evidence',
};
```

When the actor's role (read from `window.xcp.store.getSession().role`) lacks the mapped permission per `window.policy.permissionsFor(role, key, projectId)`, the reducer:
1. Refuses the action (`return state`)
2. Publishes a `policy.violation` envelope with `rule: 'reducer-permission-gate'` plus actor_id, actor_role, project_id, attempted_action, permission_key

### Why second-line defense matters even with UI gates

The Signoff widget already gates `signoff-wi` via `canSignoff = window.policy.permissionsFor(role, 'can_signoff_evidence', projectId)`. But:
- Future widgets that forget to gate would silently allow forbidden actions to mutate state
- Programmatic dispatch (e.g. `window.__xdispatch` test hook · or future automation) bypasses the UI entirely
- External agents (post-DAL adapter swap) may dispatch via the EventBus without UI mediation

The reducer is the last line where role/policy can be checked before state mutates. Defense in depth.

### Fail-open semantics (intentional)

The gate skips and the action proceeds when ANY of these is missing: permKey not in map · session null · session.role empty · window.policy missing · permissionsFor not a function. This preserves dev / CI / cold-paint paths and matches the existing Phase 5B guard's defensive shape. Codified in L-260504-REDUCER-POLICY-GATE-FAIL-OPEN-1.

### TDD catch-up (commit `ab90451` · 2026-05-04 · Tier-1.1)

`tests/e2e/v3-reducer-policy-gate.spec.ts` was authored as a 3-test catch-up: denial path (Engineer attempting signoff-wi → envelope fires + state unchanged), fail-open path (window.policy=undefined → action proceeds), introspection (dist/v3-app.js contains the map). Two testability hooks added: `window.__xdispatch(action)` and `window.__xstore()`. Both no-ops in production; not added to runBootCheck.

### Smoke-cli enforcement (4 invariants · commit `7b256d6`)

- `Phase 6.3: App.jsx defines REDUCER_ACTION_TO_PERMISSION map`
- `Phase 6.3: reducer gate covers approve-wi · promote-to-signoff · signoff-wi`
- `Phase 6.3: reducer publishes policy.violation envelope on denial`
- `Phase 6.3: reducer gate is fail-open when policy/session missing`

### Lift trigger for extending the gate

Adding more actions requires: (1) new permission key in workspace.json + per-project manifest if scoped · (2) new entry in REDUCER_ACTION_TO_PERMISSION · (3) new smoke-cli check · (4) new per-role Playwright spec · (5) amendment row here. Currently 3 actions gated; expanding to all 13 reducer action types is deferred until a pilot demands per-role policies for triage/build/etc.
