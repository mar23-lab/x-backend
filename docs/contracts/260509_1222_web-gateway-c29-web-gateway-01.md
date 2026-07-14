---
id: c29_web_gateway_01
title: C29-WEB-GATEWAY-01 Web Gateway Implementation
created_at: "2026-05-09T12:22:00+10:00"
date_key: "260509_1222"
timezone: Australia/Melbourne
owner: Marat Basyrov
status: implemented_runtime_gateway
lifecycle_state: sterile_active
graph_required: true
scope: current_root_app_runtime
runtime_change_authorized: true
xfront_import_authorized: false
xfront_mutation_authorized: false
xcp_platform_mutation_authorized: false
archive_delete_move_authorized: false
source_files:
  - docs/contracts/260509_1209_storybook-p0-chain-c29-story-p0-chain-01.md
  - src/pages/personal/Personal.jsx
  - index.html
  - scripts/smoke-cli.v3-source.mjs
---

# C29-WEB-GATEWAY-01 Web Gateway Implementation

## Executive Verdict

Implemented the first-viewport gateway in the current root app from the
Storybook proof.

The runtime entry now makes the first 30 seconds explicit:

`Workspace -> Project -> Intent -> Governed triage -> Work item -> Build/evidence -> Sign-off -> Learning/XCP`

This is a product workflow surface. It does not import x-front code and does
not embed the xcp-platform AI governance infrastructure admin dashboard.
Instead, it shows xcp-platform as a linked platform workspace/domain while
preserving the separate xcp-platform admin surface.

## Role And Skill Panel

| Role | Lens Applied |
|---|---|
| Chief-of-Staff | sequence continuity from Storybook proof to runtime |
| CTO | current-root implementation, no source blending |
| UX | first-30-second comprehension and compact context |
| Product Manager | MB-P, Xlooop, xcp-platform, and invited/client workspace fit |
| Knowledge Architect | visible chain from intent to learning |
| AI Governed Infrastructure Manager | separation between product shell and xcp-platform admin dashboard |
| DevSecOps | actor, role, visibility, and sensitivity context |
| Lead Engineer | smoke gate contract updated |

## Implemented Files

| File | Purpose |
|---|---|
| `src/pages/personal/Personal.jsx` | runtime gateway chain and actor/role/visibility/sensitivity context |
| `index.html` | web-first gateway layout and responsive grid updates |
| `scripts/smoke-cli.v3-source.mjs` | static smoke contract now requires workspace/project/intent chain and context |

## Boundary Decision

| Surface | Decision |
|---|---|
| Xlooop-XCP-demo | GO: cross-organisational product/workspace gateway |
| x-front | NO-GO: no source import or mutation in this slice |
| xcp-platform | NO-GO: no mutation; full AI governance infrastructure admin UI remains separate |
| Archive/delete/move | NO-GO |

## Next Slice

After this PR merges, the next safe slice is **C29-WEB-GATEWAY-02**:

- connect the gateway cards to richer workspace/project status data;
- keep the entry compact and web-first;
- avoid mobile work until the web workflow is stable;
- preserve xcp-platform admin/dashboard separation.
