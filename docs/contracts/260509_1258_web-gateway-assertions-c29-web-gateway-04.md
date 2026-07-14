---
id: c29_web_gateway_04
title: C29-WEB-GATEWAY-04 Gateway Route Assertions And Density Tightening
created_at: "2026-05-09T12:58:00+10:00"
date_key: "260509_1258"
timezone: Australia/Melbourne
owner: Marat Basyrov
status: implemented_route_assertions
lifecycle_state: sterile_active
graph_required: true
scope: current_root_app_runtime
runtime_change_authorized: true
xfront_import_authorized: false
xfront_mutation_authorized: false
xcp_platform_mutation_authorized: false
archive_delete_move_authorized: false
source_files:
  - docs/contracts/260509_1244_web-gateway-routing-c29-web-gateway-03.md
  - src/pages/personal/Personal.jsx
  - tests/e2e/c29-web-gateway-routing.spec.ts
  - playwright.config.ts
  - index.html
  - scripts/smoke-cli.v3-source.mjs
---

# C29-WEB-GATEWAY-04 Gateway Route Assertions And Density Tightening

## Executive Verdict

Implemented focused all-lane route assertions for the current web gateway and
trimmed gateway density/copy.

This closes the main risk left after C29-WEB-GATEWAY-03: the routing behavior is
now verified through browser-level assertions for every gateway lane, not only
through source inspection.

## Implemented Files

| File | Purpose |
|---|---|
| `tests/e2e/c29-web-gateway-routing.spec.ts` | asserts intake, sign-off, workspace, and learning routes for Xlooop, MB-P, xcp-platform, and invited/client lanes |
| `playwright.config.ts` | adds the gateway routing spec to the current default e2e gate |
| `src/pages/personal/Personal.jsx` | adds stable test IDs and tighter operational lane copy |
| `index.html` | tightens gateway spacing, heading scale, and card density |
| `scripts/smoke-cli.v3-source.mjs` | pins the existence of the all-lane route assertion spec |

## Route Coverage

| Lane | Intake target | Sign-off target | Learning target |
|---|---|---|---|
| Xlooop | Xlooop Agency / TrinityOps / Inbox | Xlooop Agency / TrinityOps / Sign-off | Xlooop Agency / TrinityOps / Substrate |
| MB-P | MB-P / MB-P governance / Inbox | MB-P / MB-P governance / Sign-off | MB-P / MB-P governance / Substrate |
| xcp-platform | xcp-platform / XCP platform roadmap / Inbox | xcp-platform / XCP platform roadmap / Sign-off | xcp-platform / XCP platform roadmap / Substrate |
| Client / invited | Northwind Co. / Logistics core / Inbox | Northwind Co. / Logistics core / Sign-off | Northwind Co. / Logistics core / Substrate |

## Density Changes

- Reduced gateway heading size and vertical gaps.
- Shortened lane card body copy.
- Changed active context from `Active lane:` to `Lane:`.
- Kept the first-30-second chain visible without adding mobile work.

## Boundary Decision

| Surface | Decision |
|---|---|
| Xlooop-XCP-demo | GO: current-root route assertions and density tightening implemented |
| x-front | NO-GO: no source import or mutation |
| xcp-platform | NO-GO: no mutation; admin dashboard remains separate |
| Archive/delete/move | NO-GO |

## Next Slice

After this PR merges, the next safe slice is **C29-WEB-GATEWAY-05**:

- refine the gateway's first-viewport information hierarchy after owner visual
  review in the browser;
- avoid new runtime architecture until gateway usability is confirmed;
- keep x-front absorption as separately scoped, evidence-led slices only.
