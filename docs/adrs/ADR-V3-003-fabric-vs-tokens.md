# ADR-V3-003 · Compliance Fabric vs design Tokens — terminology and surfaces

**Status:** Accepted
**Date:** 2026-05-03
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ddd-glossary.md](../ddd-glossary.md), [demo-ux-blueprint.md](../demo-ux-blueprint.md)

## Context

Two unrelated concepts share an unfortunate semantic neighborhood and risk being conflated in code, UI, and documentation:

- **Design tokens** — visual primitives (colour, spacing, typography, radius, shadow). Consumed by the UI to render. Represented in `theme/tokens.ts`, `entities/token`, `entities/tokenCollection`, `entities/tokenValue`. Surfaced in the **Tokens widget** (`widgets/tokens/`).
- **Compliance Fabric** — a *graph* representing coverage of evidence artifacts across compliance frameworks (SOC 2 / ISO 27001 / GDPR / internal SOPs / etc.) with freshness SLAs and reuse ratios. Consumed by the Fabric pane to render a coverage matrix. Represented as a fabric/coverage model. Surfaced in the **Fabric pane** (`widgets/fabric/`).

The risk: someone calls Fabric entries "tokens" because both feel like enumerated atoms; or someone merges the UIs because both show grids. This would muddy domain language, break Storybook contracts, and confuse buyers.

## Decision

**Compliance Fabric and design Tokens are explicitly distinct surfaces, code paths, glossary entries, and Storybook stories. They never share a UI.**

| Concern | Design Tokens | Compliance Fabric |
|---|---|---|
| What it represents | Visual primitives | Coverage graph across frameworks |
| Data shape | `{id, kind, value, theme, references[]}` | `{framework, control, evidence_id, freshness, reuse_ratio}` |
| Code home | `theme/`, `entities/{token,tokenCollection,tokenValue}` | `widgets/fabric/`, `entities/fabric*` (post-Phase 3.5) |
| UI route | Tokens widget | Fabric pane |
| Glossary entry | "Token (design)" | "Compliance Fabric" |
| Storybook story | `Theme/Tokens` | `Surfaces/Fabric` |
| Owner | Designer | Compliance Manager |

Vocabulary discipline:
- The word "Tokens" in v3 always refers to design tokens unless explicitly qualified as "Compliance Fabric tokens" — and even that compound is **discouraged**; prefer "Fabric controls" or "Fabric entries."
- Naming a new field in a shared module (e.g. `data/CONTRACTS.md`) that uses "token" is reserved for design tokens.
- Fabric data shape never reuses `kind: "token"`.

## Consequences

**Positive:**
- Buyers see two distinct, focused surfaces, each carrying its own narrative.
- Designers and Compliance Managers each own a clear surface.
- Storybook discipline is preserved (one story per concern).
- Glossary stays terminologically clean.

**Negative:**
- Two folders, two glossary entries, two Storybook trees — slight overhead.
- Future contributor must respect the line; review enforces it.

**Out of scope:**
- Any future "design system fabric" or "token graph" idea — those would need their own ADR superseding this one.

## Verification

- `ddd-glossary.md` carries both entries with a cross-link to this ADR.
- `widgets/tokens/` and `widgets/fabric/` are separate folders (created post-port; placeholder READMEs today).
- `data/*.json` files do not contain Fabric data inside Tokens objects or vice versa (enforced by code review and contract tests).
- Search `grep -r "fabric.*token\|token.*fabric" v3/` returns 0 hits at any release point.

## References

- [risk-register.md D8](../risk-register.md)
- [demo-ux-blueprint.md](../demo-ux-blueprint.md) (fidelity map)
- [ddd-glossary.md](../ddd-glossary.md)
