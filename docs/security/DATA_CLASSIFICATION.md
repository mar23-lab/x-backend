# Data classification taxonomy (SSOT · v1 · 2026-07-07)

Formalizes the classes ALREADY ENFORCED in code, and fixes the vocabulary the M3 `data_class`
response envelope will declare per response (Wave 2). Evidence-bound; each class cites enforcement.

## The five customer-facing data classes (→ M3 `data_class` enum)

| `data_class` | Meaning | Enforcement today (evidence) |
|---|---|---|
| `live` | The tenant's own operational records | app `WHERE workspace_id` + **DB RLS** via non-owner `xlooop_app` on operation_events, projects, documents, board_cards, project_source_bindings (migrations 043–047); cross-tenant negative proofs (A.3) |
| `starter` | Labeled day-1 onboarding content | customer-workspace-feed.ts ("only starter content a new customer can safely consume on day 1"), same tenant-scoped DAL + Clerk authority |
| `template` | Redacted governance/template projections | template-policy-registry.ts ("effective redacted templates … never exposes raw MB-P governance files, private graph/IP, internal scoring, agent routing, secrets") |
| `redacted` | Metadata-only exports/receipts | customer-data export `export_mode='metadata_redacted_only'` + hardcoded blocked_surfaces list (operational-spine.ts:301-335) |
| `public_safe` | Unauthenticated placeholder tier | `visibilityForRole('client') = ['public_safe']` (dal/visibility.ts, tested); static publish-dir stubs `items: [], public_safe: true` |

## Row-level visibility tiers (orthogonal axis, within `live`)
`internal_owner_only ⊃ internal_workspace ⊃ internal_project ⊃ public_safe` — resolved per role by
`visibilityForRole` (owner sees all four; operator w/o owner-only; viewer project+public; client
public_safe only). Evidence: dal/visibility.ts + visibility.test.ts.

## Sensitivity handling
- **Secrets/credentials:** never stored plaintext (tokens = SHA-256 only, migration 037); Sentry
  beforeSend redacts `password|token|secret|key|jwt|authorization|cookie|api-key` (sentry.ts).
- **PII:** identity lives in Clerk (processor); Xlooop stores user_id/org_id references + typed-name
  consent records (name, IP, user-agent — retained as legal evidence, migration 018).
- **MB-P/internal artifacts:** operator-gated behind `MBP_OWNER_USER_ID` (mbp-projection.ts — any
  other authenticated user gets 403); never any customer data_class.

## Rules
1. Every tenant-facing response MUST declare exactly one `data_class` (M3 gate, Wave 2).
2. A class downgrade (e.g. template→live) is a defect of the highest severity — it misrepresents
   provenance to the customer.
3. New surfaces must pick a class at design time; "unclassified" is not a class.
