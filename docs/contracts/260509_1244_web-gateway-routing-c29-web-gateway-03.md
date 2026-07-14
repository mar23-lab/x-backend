---
id: c29_web_gateway_03
title: C29-WEB-GATEWAY-03 Lane-Aware Gateway Routing
created_at: "2026-05-09T12:44:00+10:00"
date_key: "260509_1244"
timezone: Australia/Melbourne
owner: Marat Basyrov
status: implemented_lane_aware_routing
lifecycle_state: sterile_active
graph_required: true
scope: current_root_app_runtime
runtime_change_authorized: true
xfront_import_authorized: false
xfront_mutation_authorized: false
xcp_platform_mutation_authorized: false
archive_delete_move_authorized: false
source_files:
  - docs/contracts/260509_1234_web-gateway-status-c29-web-gateway-02.md
  - src/pages/personal/Personal.jsx
  - index.html
  - scripts/smoke-cli.v3-source.mjs
---

# C29-WEB-GATEWAY-03 Lane-Aware Gateway Routing

## Executive Verdict

Implemented lane-aware routing for the current web gateway.

The gateway no longer sends every primary action and chain step to
`xlooop-agency/trinity`. Users now select the active lane first, then gateway
actions route to that lane's workspace or focus project.

## Implemented Files

| File | Purpose |
|---|---|
| `src/pages/personal/Personal.jsx` | adds selected lane state, focus-project routing, step-to-mode mapping, and lane-specific action dispatch |
| `index.html` | adds selected-lane visual state and compact card actions |
| `scripts/smoke-cli.v3-source.mjs` | pins the lane-aware routing contract and blocks a hardcoded Trinity default regression |

## Routing Contract

| Gateway action | Route rule |
|---|---|
| Select lane chip | Sets active lane context only |
| Start governed intake | Active lane focus project -> `inbox`; workspace fallback if no project |
| Open sign-off queue | Active lane focus project -> `signoff`; workspace fallback if no project |
| Workflow step: Workspace | Opens active lane workspace |
| Workflow step: Project | Opens active lane focus project overview |
| Workflow steps: Intent/Triage/Work/Evidence/Sign-off/Learning | Opens active lane focus project in the mapped mode |
| Lane card: Open workspace | Opens that lane's workspace |
| Lane card: Open sign-off | Opens that lane's focus project sign-off |

## Boundary Decision

| Surface | Decision |
|---|---|
| Xlooop-XCP-demo | GO: current-root gateway routing implemented |
| x-front | NO-GO: no source import or mutation |
| xcp-platform | NO-GO: no mutation; admin dashboard remains separate |
| Archive/delete/move | NO-GO |

## Known Limits

- This is still fixture-driven product proof, not a backend permission engine.
- Mobile remains deferred by owner decision.
- The xcp-platform lane shows roadmap/substrate work visible inside the
  cross-organisational product shell; it does not embed the separate XCP
  infrastructure administration dashboard.

## Next Slice

After this PR merges, the next safe slice is **C29-WEB-GATEWAY-04**:

- add focused route assertions for each lane in the browser or Playwright;
- tighten gateway density/copy after route behavior is proven;
- keep x-front as reference-only until an explicitly scoped absorption slice.
