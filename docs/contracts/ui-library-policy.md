# UI Library Policy (P10C.10)

> **Phase 10C P10C.10** · policy ratification ONLY · NO build · NO runtime mutation · NO wrapper implementation · NO x-front source mutation.
> **Generated:** 2026-04-28.
> **Companion:** [`ui-library-policy.json`](ui-library-policy.json) (canonical machine-readable · contract of record).
> **Status:** RATIFIED at c171.
> **Current operational status:** superseded-retained for implementation location as of C6 on 2026-05-08. This policy remains historical evidence of what was ratified in P10C/P10D; it is not active approval to create new `v2/src/ui` product code. New x-front-derived wrapper work must be re-authorized for v3-owned locations through a fresh ADR/contract gate.

---

## 1 · Executive verdict

**🟢 RATIFIED:** `ratify_future_wrappers`.

**C6 update:** the ratification remains useful evidence, but the active product path is v3. Treat all `v2/src/ui` implementation-location statements below as historical P10C/P10D scope, not as current implementation instructions.

P10C.10 ratifies **3** Xlooop-owned wrappers for future Phase 10D implementation:

| Wrapper | Source asset | Score | Status | CTO review |
|---|---|---:|---|:---:|
| `XAvatar` | `shared/uiKit/Avatar` | 85.2 | ratified | — |
| `XEvidenceImage` | `shared/uiKit/Image` | 83.3 | ratified · conditional | required at pre-merge |
| `XEvidencePreview` | `shared/uiKit/Preview` | 81.5 | ratified · conditional | required at pre-merge |

**3 wrappers remain deferred.** `XDialog` · `XFieldsFamily` · `XSidebarCode` are not ratified by this policy.

**Effect:** P10C.7 adoption decision stands. Phase 10D wrapper implementation is unblocked after Phase 10C signoff (P10C.13). No runtime code lands in P10C.10.

---

## 2 · Purpose

P10C.10 converts the P10C.7 future-adoption decision into an enforceable contract of record. It answers:

- Which UI wrappers are approved for future implementation? (§4)
- Where may they live? (§7)
- What source candidates are they allowed to wrap? (§4)
- What hard gates must remain true? (§8)
- What imports are forbidden? (§6)
- What voids the approval? (§9)
- What smoke checks enforce the policy? (§10)

P10C.10 is **policy ratification only**. It is not a UI implementation phase, not a refresh of P10C.6 scorecard, and not a re-evaluation of deferral reasons.

---

## 3 · Inputs and evidence chain

| Input | File |
|---|---|
| P10C.7 adoption decision (canonical) | `docs/_archive/audits/xfront-adoption-decision.json` |
| P10C.7 wrapper design (per-wrapper contracts) | `docs/design/xfront-wrapper-design.md` |
| P10C.6 scorecard (frozen · rubric c160) | `docs/_archive/audits/xfront-component-scorecard.json` |
| P10C.6 rubric source | `docs/evaluations/ui-library-evaluation.md` §6 |
| P10C.5A contract maturity | `docs/_archive/audits/xfront-contract-maturity-audit.json` |
| P10C.5 R2 dependency audit | `docs/_archive/audits/xfront-r2-dependency-audit.json` |
| P10C.9 intake-area decision | `docs/_archive/audits/xfront-intake-area-decision.json` |
| ADR-0004 (intake policy · D2 forbids x-front in v2) | `docs/adrs/0004-xfront-intake-policy.md` |

All inputs verified at policy generation. **No re-runs.** No prior decisions changed.

---

## 4 · Ratified future wrappers

All ratified wrappers share: implementation phase = Phase 10D · location = `v2/src/ui/` · source policy = `wrap_only_no_direct_import` · source pin = `8f62f6b`.

| # | Wrapper | Source | Score / band | CTO review | Scope constraint |
|---|---|---|---|:---:|---|
| 4.1 | `XAvatar` | `shared/uiKit/Avatar` | 85.2 · 85-89 (`adopt_after_minor_remediation`) | — | team-identity surface ONLY (per P10C.4) |
| 4.2 | `XEvidenceImage` | `shared/uiKit/Image` | 83.3 · 75-84 (`adopt_with_wrapper`) | required at pre-merge | evidence-panel + media-preview |
| 4.3 | `XEvidencePreview` | `shared/uiKit/Preview` | 81.5 · 75-84 (`adopt_with_wrapper`) | required at pre-merge | evidence-panel + media-preview |

**Required before implementation (per wrapper):**

- **`XAvatar`:** TypeScript prop contract · Storybook states (image · initials · missing · sizes · status) · aria-label fallback chain · design-token mapping at boundary · unit tests.
- **`XEvidenceImage`:** TypeScript prop contract · **alt text REQUIRED at wrapper boundary** · loading/error/empty states explicit · Storybook states (loading · loaded · error · empty · sizes) · unit tests.
- **`XEvidencePreview`:** TypeScript prop contract · supported preview types declared (image · pdf · video · doc · unsupported) · status model explicit (idle · loading · ready · error · unsupported) · `aria-labelledby` + `aria-describedby` linkage · Storybook states (per type × per status) · unit tests.

---

## 5 · Deferred wrappers

| Wrapper | Source | Reason | Future phase | Required path |
|---|---|---|---|---|
| `XDialog` | `shared/uiKit/Dialog` | a11y blocker (no role=dialog · no aria-modal · no focus trap · no portal) | Phase 10D | Build from `@radix-ui/react-dialog` OR accessible re-implementation. **NOT** sourced from x-front. |
| `XFieldsFamily` | `shared/uiKit/Fields` | 2,524 LOC family + refactor debt | Phase 10D | Split into `XLabel` · `XTextField` · `XSelect` · `XFieldList` · `XValidationMessage` (5 separate wrappers · NOT one). Each must independently pass scorecard + maturity + R2 + license gates. |
| `XSidebarCode` | `widgets/sidebarCode` | feature coupling + product-fit pending | Phase 11+ | Phase 11+ feature decoupling AND product-fit decision. Until both resolve, no wrapper. |

**This policy does NOT ratify any deferred wrapper.** Promotion requires a fresh ratification cycle (re-score + re-audit + ADR amendment + policy_version bump).

---

## 6 · Non-direct-import policy

> **Xlooop runtime UI MUST NOT import x-front components directly.**

All access to x-front-sourced components flows through Xlooop-owned `X*` wrappers in `v2/src/ui/`. The wrapper:

- Owns the TypeScript prop contract.
- Owns the design-token mapping.
- Owns the accessibility contract.
- Owns Xlooop naming and usage constraints.
- Owns the test contract (states + interaction).
- Owns Storybook examples (Xlooop-side · not x-front).
- Preserves the freedom to swap x-front for Radix / headless without breaking callers.

**Wrapper does NOT:**

- Re-export x-front internals.
- Pass through unknown props from x-front.
- Leak x-front theme tokens into v2 callers.
- Couple to x-front's refactor-debt comments.

(Source: P10C.7 wrapper design principles · `docs/design/xfront-wrapper-design.md`.)

---

## 7 · Implementation location policy

| Allowed location | Phase |
|---|---|
| `v2/src/ui/<WrapperName>/` | Phase 10D (post P10C.13 signoff) |

**Forbidden locations** (per P10C.9 intake-area decision):

- `v2/src/integration-intake/xfront/`
- `v2/src/xfront/`
- `integration-intake/x-front/raw/`
- `integration-intake/x-front/adopted/`

Changing the canonical implementation location requires a new ADR + this policy's version bump.

---

## 8 · Hard gates (per ratified wrapper)

Every approved wrapper's source asset must hold these 6 gates at re-verification time. Failing any one → voiding (§9).

| Gate | XAvatar | XEvidenceImage | XEvidencePreview |
|---|:---:|:---:|:---:|
| `r2_clean` (R2-FREE per P10C.5) | ✓ | ✓ | ✓ |
| `mui_clean` (no `@mui/material` import in source) | ✓ | ✓ | ✓ |
| `forbidden_import_clean` | ✓ | ✓ | ✓ |
| `not_legacy_demo` (production source) | ✓ | ✓ | ✓ |
| `score_above_threshold` (≥75/100 normalized) | ✓ | ✓ | ✓ |
| `contract_maturity_eligible` (per P10C.5A) | ✓ | ✓ | ✓ |

The 3 frozen-rubric hard gates from `docs/evaluations/ui-library-evaluation.md` §6 (Accessibility · R2 independence · License risk) are subsumed by the gates above.

---

## 9 · Voiding conditions

Any of the following voids this policy and blocks Phase 10D:

1. Phase 10C does not sign off cleanly at P10C.13.
2. `source_pin` `8f62f6b` no longer resolves at Phase 10D kickoff (re-pin required + re-ratification).
3. Scorecard re-run drops any approved wrapper source below 75/100 normalized score.
4. Any approved wrapper source fails any of the 3 hard gates on re-verification.
5. Runtime implementation bypasses the Xlooop-owned wrapper contract (direct x-front import detected in `v2/src/`).
6. Any `forbidden_patterns` rule (§6) is violated in v2 runtime.

**Effect:** policy invalidated · P10C.7 adoption decision voided · Phase 10D wrapper implementation blocked until a fresh ratification cycle. P10C.9 intake-area decision still stands but loses its immediate implementation purpose.

---

## 10 · Smoke enforcement

12 new `[tier:storybook-comp]` smoke checks (added in c171) verify:

- `docs/contracts/ui-library-policy.json` exists + parses + carries `phase=P10C.10`
- `docs/contracts/ui-library-policy.md` exists with all 12 sections
- `policy_name = ui_library_policy`
- `decision = ratify_future_wrappers`
- `approved_future_wrappers` includes `XAvatar` · `XEvidenceImage` · `XEvidencePreview`
- each approved wrapper has `implementation_location = v2/src/ui/`
- each approved wrapper has `source_policy = wrap_only_no_direct_import`
- `deferred_wrappers` includes `XDialog` · `XFieldsFamily` · `XSidebarCode`
- non-direct-import policy is present in JSON `forbidden_patterns`
- `voiding_conditions` length ≥ 6
- `runtime_mutation = false` AND `xfront_source_mutation = false`
- INVARIANT: P10C.7 adoption decision NOT voided by P10C.10

**Future-facing placeholder (§7 of the JSON `future_enforcement_placeholders`):** a Phase 10D mechanical grep/AST gate failing CI on direct x-front imports in `v2/src/`. NOT implemented in P10C.10 · scheduled for Phase 10D when wrappers ship.

---

## 11 · Phase 10D handoff

Phase 10D wrapper implementation is unblocked **only when both** are true:

1. Phase 10C signoff (P10C.13) lands cleanly.
2. This policy ratification (P10C.10 · c171) is in effect (no voiding condition triggered).

**Recommended implementation order:**

1. `XAvatar` first (lowest friction · cleanest scorecard · no CTO review gate).
2. `XEvidenceImage` second (CTO review at pre-merge).
3. `XEvidencePreview` third (CTO review at pre-merge · widest type matrix).

**Phase 10D MUST NOT:**

- Import x-front components directly into `v2/src/` runtime.
- Create `v2/src/integration-intake/xfront/` (forbidden by P10C.9).
- Implement deferred wrappers without prior ratification cycle.
- Skip CTO review for `XEvidenceImage` or `XEvidencePreview`.

---

## 12 · What this policy does NOT do

P10C.10 is policy ratification only. It does **NOT**:

- Implement `XAvatar`, `XEvidenceImage`, or `XEvidencePreview`.
- Import any x-front component.
- Modify `v2/app.html` (LOC unchanged from c151 baseline · 14,686).
- Modify `v2/src/` runtime.
- Modify x-front source.
- Create wrapper Storybook stories.
- Fix `Dialog`, split `Fields`, or decouple `sidebarCode`.
- Start Phase 10D implementation.
- Refresh the P10C.6 scorecard or P10C.5A contract maturity audit.
- Change any prior P10C decision.
- Promote any deferred wrapper.

---

## Cross-references

- Adoption decision (P10C.7): [`../audits/xfront-adoption-decision.md`](../audits/xfront-adoption-decision.md)
- Wrapper design (P10C.7): [`../design/xfront-wrapper-design.md`](../design/xfront-wrapper-design.md)
- Intake-area decision (P10C.9): [`../audits/xfront-intake-area-decision.md`](../audits/xfront-intake-area-decision.md)
- Component scorecard (P10C.6): [`../audits/xfront-component-scorecard.md`](../audits/xfront-component-scorecard.md)
- UI Library Evaluation §6 (frozen rubric): [`../evaluations/ui-library-evaluation.md`](../evaluations/ui-library-evaluation.md)
- ADR-0004 (intake policy): [`../adrs/0004-xfront-intake-policy.md`](../adrs/0004-xfront-intake-policy.md)
- Workflow §15 (P10C-prep gates · governance conventions): [`../Workflow.md`](../Workflow.md)
