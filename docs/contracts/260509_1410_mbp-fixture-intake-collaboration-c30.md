---
id: c30_mbp_fixture_intake_collaboration
title: C30-FIXTURE-02 / C30-INTAKE-02 / C30-COLLAB-01 MB-P Fixture, Intake, And Collaboration Replacement
created_at: "2026-05-09T14:10:00+10:00"
date_key: "260509_1410"
timezone: "Australia/Melbourne"
status: implemented_current_surface
lifecycle_state: active_reference
owner_role: Product Manager
purpose: Record replacement of active fictional demo fixtures with MB-P/XCP current product data and governed intake packet behavior.
graph_required: true
---

# C30 MB-P Fixture, Intake, And Collaboration Replacement

## Verdict

Implemented for the **current active product surface**.

This slice removes the old active Trinity/Northstar/Vertex project fixture
manifests, migrates current Storybook mode fixtures to MB-P intake data, and
turns the Personal Home free-text intake into a governed candidate packet.

It does not claim that every historical demo reference in the repository is
gone. Remaining references are classified as follow-up surfaces: historical
docs/audits, non-current legacy e2e tests, seed-contract examples, golden-path
evidence, and the guided tour.

## Implemented

| Surface | Change |
|---|---|
| `data/initial-store.json` | current store no longer seeds `trinity`; MB-P intake, MB-P life, XCP roadmap/control-plane data are the active records |
| `data/project-data.json` | project metadata follows MB-P/XCP project ids |
| `data/projects/{trinity,northstar,vertex}/manifest.json` | removed from active project policy manifests |
| `src/shared/storybook/fixtures/mbp-fixture.ts` | replaces the old Trinity story fixture with MB-P intake/governance data |
| `src/app/App.jsx` | persists intake drafts as candidate packets with `intent_id`, lifecycle, sterility, graph visibility, role panel, and owner-review requirement |
| `src/pages/personal/Personal.jsx` | free-text intake submits into the governed packet path instead of only navigating |
| `src/widgets/demo-tour/DemoTour.jsx` | guided tour scenes rewritten to MB-P/XCP workflow paths |
| signed review fixtures/tests | reframe collaboration as owner-approved MB-P collaborator review packet, not fictional client tenant data |
| `src/widgets/AdminMenu/AdminMenu.jsx` | active preset labels/test ids changed from demo presets to workspace presets |

## Packet Contract

Free-text intake now creates candidate work items with:

- `intent_id`
- `packet_id`
- `lifecycle_state: candidate_owner_review_required`
- `sterility_state: sterile_quarantined`
- `graph_required: true`
- `owner_review_required: true`
- `role_panel`
- selected target domains/projects

This is still front-end persistence, not the final MB-P backend intake ledger.
The next backend slice should write the same shape to the governed intake root.

## Remaining Demo Surfaces

| Surface | State | Recommendation |
|---|---|---|
| `src/contracts/seed-contracts.ts` | example contract fixtures | replace with MB-P/XCP examples or move to retained evidence |
| `src/shared/storybook/golden-path/` | retained golden-path evidence | migrate to MB-P owner-intake chain |
| non-current Playwright specs outside the current gate | legacy evidence | migrate only where they still prove current product behavior |
| historical docs/audits | historical evidence | retain as provenance; do not treat as current product copy |

## Gate Evidence

- `npm run smoke` -> passed before contract cleanup.
- `npm run build:standalone` -> passed before contract cleanup.
- `npm run test:e2e` -> passed before contract cleanup.
- `npm run test:contracts` -> passed before contract cleanup.
- `npm run test:unit` -> passed before contract cleanup.
- `npm run build-storybook` -> passed before contract cleanup.

## Next

1. `C30-SEED-CONTRACTS-03`: replace seed-contract examples with MB-P/XCP or retain explicitly as historical examples.
2. `C30-GOLDEN-PATH-03`: migrate golden-path Storybook/e2e evidence to the MB-P chain.
