# ADR-V3-017 · FSD `features/` layer · accept 5-layer variant

**Status:** Accepted 2026-05-07 (audit Day 5 · item 2.8)
**Date:** 2026-05-07
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ADR-V3-008](ADR-V3-008-fsd-layout.md), audit `AUDIT_PHASE_C4_M8_2026-05-05.md` item 2.8

## Context

Canonical Feature-Sliced Design (FSD) defines six layers: app · pages · widgets · features · entities · shared. v3 today has five — no `features/` directory exists. x-front (the comparison repo) has 30+ feature slices.

The audit (item 2.8) flagged this as a silent FSD violation: either v3 is implicitly using a 5-layer variant (which contradicts ADR-V3-008's claim of canonical FSD) or v3 is silently mis-organising features inside the widgets layer.

Specifically, the M8 work in `widgets/project-modes/Substrate/Substrate.jsx` does feature-layer work (port construction, source toggle URL handling, runtime React-mounting) inside what should be a widget shell. By strict FSD, this should live in `features/substrate-host/` with the widget reduced to a slot.

## Decision

**Accept the 5-layer variant.** v3 explicitly skips the `features/` layer until proven necessary by a real feature reuse case.

Rationale:
1. v3 widgets are currently **mode-shaped**, not feature-shaped. Each `project-modes/<Mode>/` is a coherent unit — extracting a `features/` layer here would split logic without separation gain.
2. v3 has **0 reuse cases today** where two widgets share the same feature. x-front has many because it builds a UI builder with shared editing tools; v3 builds a governance dashboard with mode-specific views.
3. Adding `features/` for the sake of FSD purity is over-engineering · the [Boil the Lake](https://garryslist.org/posts/boil-the-ocean) test fails when there's no second consumer.

**Trigger to add `features/`:** when a SECOND widget needs the same logic. Specifically:
- If both Evidence and Substrate need the same port-construction helper → `features/evidence-port/`
- If both Triage and Build need the same WI-status-machine logic → `features/wi-status/`
- If two project-modes need the same skill-registry filter logic → `features/skill-filter/`

Until that triggers, keep the 5-layer pattern. Update `docs/adrs/ADR-V3-008-fsd-layout.md` to mention the variant explicitly. Update `shared/storybook/docs/FSD-layers.mdx` to call out the deviation honestly.

## Consequences

**Positive:**
- No premature abstraction · code stays where it's read.
- Honesty: docs match implementation.
- Easier mental model for new contributors · five clear layers, no ambiguous middle.
- Trigger condition is explicit and testable (count-of-consumers).

**Negative:**
- Diverges from x-front's pattern. If we ever physically merge the two repos (Plan v3 §E post-W6), the merge needs a feature-layer alignment pass.
- A future maintainer might add a `features/` directory unprompted, thinking we forgot. Solution: this ADR cited in FSD-layers.mdx.

**Out of scope:**
- Refactoring widgets/project-modes/Substrate/ to extract feature logic · not worth it for one-off.
- Migrating x-front to the 5-layer pattern · separate decision when consolidation lands.

## Verification

- `find v3/project/v3/features -type f 2>/dev/null` returns empty (no features layer)
- `FSD-layers.mdx` documents the 5-layer variant + the trigger condition
- `ADR-V3-008` linked
- Smoke-cli check: confirm zero `features/` directory

## Re-evaluation triggers

Re-open this ADR if any of:
- 2 widgets share substantively identical logic (>50 LOC overlap)
- A pilot customer asks for v3-feature reuse across products (e.g. "add this widget to ClauseLoop too")
- x-front and v3 are about to physically merge

Otherwise, this stands as v3's permanent stance.
