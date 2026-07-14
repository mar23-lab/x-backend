---
id: c29_web_gateway_02
title: C29-WEB-GATEWAY-02 Gateway Status Data Integration
created_at: "2026-05-09T12:34:00+10:00"
date_key: "260509_1234"
timezone: Australia/Melbourne
owner: Marat Basyrov
status: implemented_runtime_status_data
lifecycle_state: sterile_active
graph_required: true
scope: current_root_app_runtime
runtime_change_authorized: true
xfront_import_authorized: false
xfront_mutation_authorized: false
xcp_platform_mutation_authorized: false
archive_delete_move_authorized: false
source_files:
  - docs/contracts/260509_1222_web-gateway-c29-web-gateway-01.md
  - src/pages/personal/Personal.jsx
  - index.html
  - scripts/smoke-cli.v3-source.mjs
---

# C29-WEB-GATEWAY-02 Gateway Status Data Integration

## Executive Verdict

Implemented richer workspace/project status in the current root gateway.

The gateway no longer relies on fixed showcase metrics for its main cards.
It now derives card status from the already-loaded root app data:

- `SPACES`
- `WS_PROJECTS`
- `HOME.client_reviews`

This keeps the gateway current with the product model while avoiding any
x-front import and avoiding any xcp-platform mutation.

## Implemented Files

| File | Purpose |
|---|---|
| `src/pages/personal/Personal.jsx` | adds `workspaceStats()` and `gatewayLaneData()` to derive gateway status and metrics |
| `index.html` | adds compact status styling for gateway cards |
| `scripts/smoke-cli.v3-source.mjs` | pins the runtime gateway data helpers in smoke |

## Data Contract

| Gateway Lane | Data Source | Output |
|---|---|---|
| MB-P | `WS_PROJECTS['mbp-private']` | projects, intents, sign-off, focus project |
| Xlooop | `WS_PROJECTS['xlooop-agency']` | projects, intents, sign-off, at-risk marker |
| xcp-platform | `WS_PROJECTS['xcp-platform']` | roadmap/control-plane project status as product-visible substrate/domain status |
| Client / invited | `SPACES` + `HOME.client_reviews` | invited workspace count, client portals, active client review count |

## Boundary Decision

| Surface | Decision |
|---|---|
| Xlooop-XCP-demo | GO: use local product data to enrich gateway |
| x-front | NO-GO: no source import or mutation |
| xcp-platform | NO-GO: no mutation; full admin dashboard remains separate |
| Archive/delete/move | NO-GO |

## Next Slice

After this PR merges, the next safe slice is **C29-WEB-GATEWAY-03**:

- make gateway actions route by lane context instead of always defaulting to
  `xlooop-agency/trinity`;
- preserve web-first UX;
- keep mobile deferred;
- keep x-front reference-only.
