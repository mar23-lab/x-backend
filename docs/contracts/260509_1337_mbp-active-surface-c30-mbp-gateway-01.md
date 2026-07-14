---
id: c30_mbp_gateway_01
title: C30-MBP-GATEWAY-01 MB-P Active Surface And Intake Gateway
created_at: "2026-05-09T13:37:00+10:00"
date_key: "260509_1337"
timezone: "Australia/Melbourne"
status: implemented_active_surface
lifecycle_state: active_reference
owner_role: Product Manager
purpose: Record the pivot from fictional demo tenants to MB-P ecosystem active data for the current Xlooop-XCP Demo root app.
graph_required: true
---

# C30-MBP-GATEWAY-01 MB-P Active Surface And Intake Gateway

## Verdict

Implemented the first active-surface pivot from generic/commercial demo data to
MB-P ecosystem data.

This does **not** claim every legacy fixture has been removed. The honest state:

- active first viewport, gateway lanes, workspace seed data, topbar presets, and
  current policy are MB-P/XCP only;
- old Trinity/Acme/Northwind-style data remains in legacy tests, Storybook
  fixtures, historical docs, and `initial-store.trinity` as retained fixture
  evidence until replacement tests exist;
- the current e2e gate no longer treats Trinity-specific Fabric, lineage, or
  reverse-loop tests as current product readiness.

## Why

Owner visual review found that fictional tenants were confusing the purpose of
the product. The Xlooop-XCP Demo should now prove the MB-P ecosystem as the real
operational harness: owner intake, governed triage, multi-domain routing,
evidence, sign-off, and XCP platform learning.

## Implemented

| Surface | Change |
|---|---|
| `data/spaces.json` | active spaces reduced to Marat, MB-P, and XCP platform |
| `data/ws-projects.json` | active projects replaced with MB-P governance, Unified intake, Private domains, XCP roadmap, and XCP control plane |
| `data/home.json` | active decisions, requests, approvals, recent activity, and mentions are MB-P/XCP only |
| `data/ws-detail.json` | active workspace details are MB-P/XCP only |
| `data/workspace.json` | active workspace policy is MB-P, not Xlooop Agency |
| `data/projects/*/manifest.json` | active project policy manifests added for MB-P/XCP projects |
| `src/pages/personal/Personal.jsx` | gateway defaults to MB-P, removes Xlooop/invited lanes, adds free-text intake draft panel |
| `src/widgets/AdminMenu/AdminMenu.jsx` | topbar presets changed from fictional demo presets to MB-P/Intake/Governance/XCP workspace anchors |
| `src/app/App.jsx` | reset/preset copy changed from demo language to workspace seed language |
| `tests/e2e/c29-web-gateway-routing.spec.ts` | current gateway assertions changed to MB-P/XCP lanes and free-text intake route |
| `playwright.config.ts` | legacy Trinity-specific Fabric, lineage, and reverse-loop tests removed from current readiness gate |

## Critical Assessment

### What is now aligned

The first 30 seconds now says the right thing:

`MB-P workspace -> project/domain -> owner intent -> governed triage -> work item -> evidence -> sign-off -> XCP learning`.

The app now has a visible free-text intake draft surface. It is still a
front-end draft, not a persisted backend intake event. That is acceptable for
this slice because it proves the workflow placement and routes to the governed
triage surface.

### What is still missing

| Gap | Severity | Recommendation |
|---|---:|---|
| Free-text intake is not persisted as an `intent_id` / packet | High | Build C30-INTAKE-02 against real intake contract |
| Legacy Trinity/Acme fixtures still exist in Storybook/tests/docs | Medium | Replace only after MB-P equivalent fixtures exist |
| Client review capability is now generic service-only, not active product flow | Medium | Reintroduce via owner-approved invited collaborator scenario, not fake tenants |
| MB-P project mode data is still thinner than Trinity legacy fixture data | Medium | Add MB-P lineage/evidence/sign-off fixtures from real MB-P governance packets |
| `DemoPresets` compatibility name remains | Low | Rename only after story/test consumers are migrated |

## Gate Evidence

- `npm run smoke` -> 322/322 passed.
- `npm run build:standalone` -> passed.
- Focused e2e:
  `npx --no-install playwright test tests/e2e/c29-web-gateway-routing.spec.ts tests/e2e/v3-demo-presets.spec.ts tests/e2e/v3-skills-policy.spec.ts tests/e2e/v3-policy-gated-signoff.spec.ts`
  -> 7/7 passed.
- Current e2e:
  `npm run test:e2e` -> 23 passed, 4 skipped.

## Next

1. `C30-INTAKE-02`: persist the free-text intake draft into an intake packet
   shape with `intent_id`, candidate domains, owner confirmation, role panel,
   lifecycle, sterility, and graph visibility.
2. `C30-FIXTURE-02`: replace retained Trinity fixtures with MB-P governance /
   intake / XCP platform fixtures for Storybook and e2e coverage.
3. `C30-COLLAB-01`: reintroduce external collaboration as a permissioned
   owner-approved scenario, not demo Acme/Northwind data.
