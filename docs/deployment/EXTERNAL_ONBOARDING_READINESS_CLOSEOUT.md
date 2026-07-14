# External Onboarding Readiness Closeout

External customer onboarding stays paused until the public hard-stop reports
`public_production_authority: true`.

Canonical go/no-go command:

```bash
npm run verify:live-authority-inputs
npm run verify:public-production-readiness-hard-stop -- --strict-public
```

This runbook is the operator checklist for closing the remaining live authority
gates without committing secrets or fabricating evidence. Normal verifier mode
may pass for internal controlled validation; strict public mode must fail closed
until every live lane below has authority.

Latest closure handoff:

- [`docs/handoffs/XLOOOP_LIVE_AUTHORITY_LANES_SESSION_CLOSEOUT_2026-07-03.md`](../handoffs/XLOOOP_LIVE_AUTHORITY_LANES_SESSION_CLOSEOUT_2026-07-03.md)

## Evidence Hygiene

- `verify:live-authority-inputs` is a preflight doctor only. It checks whether
  the live-lane env vars and evidence files are configured and shaped correctly;
  it does not grant production authority.
- Put secrets only in local environment variables or local token files.
- Do not commit token files, raw customer data, raw production exports, or
  mutable latest receipts.
- Evidence files referenced by env vars must be sanitized, immutable, and safe
  to summarize in PRs.
- PR #740 remains the recovery lane. Do not merge as external-onboarding-ready
  unless all authority flags are true.

## Authority Matrix

| Lane | Required inputs | Commands | Required authority | Evidence file | Acceptance | Rollback / stop |
| --- | --- | --- | --- | --- | --- | --- |
| Production DB/RLS | `DATABASE_URL`, `XLOOOP_RLS_APP_DATABASE_URL` | `npm run verify:prod-migrations -- --json`; `npm run verify:postgres-rls-app-role`; `npm run verify:production-db-live-authority -- --strict-live-db` | `production_db_live_authority=true` | Command output only; no DSNs | Migrations include `036_customer_learning_personalization.sql`; app-role RLS denies non-owner access | Keep onboarding paused; do not apply prod migrations without owner-approved backup/snapshot and named migration plan |
| API/MCP live canary | `XLOOOP_PARITY_PACKET_ID=pkt-canary-*`, `XLOOOP_CANARY_API_TOKEN_FILE`, `XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE` | `npm run verify:api-mcp-lifecycle-parity -- --format=json`; `npm run verify:api-mcp-live-canary-hard-stop -- --strict-live` | `api_mcp_live_canary_authority=true` | Sanitized canary result summary | `whoami` binds correct tenant/user; read-only packet works; lifecycle canary proves revocation blocks access | Revoke canary tokens; remove/expire canary packet; keep customer MCP read-only |
| Delete/export/legal-hold | `XLOOOP_DELETE_EXPORT_RECEIPT_FILE` | `npm run verify:delete-export-execution`; `npm run verify:public-self-serve-production-receipts` | `public_self_serve_authority=true` | Sanitized `production_live_receipt` JSON | Canary object has export, delete request, object-storage proof, legal-hold behavior, retention boundary, and non-recovery/rollback statement | Keep self-serve delete/export disabled; do not test against real customer data |
| Two-company live proof | `XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE` | `npm run verify:two-company-live-pilot-evidence`; `npm run verify:tenant-search-isolation`; `npm run verify:customer-chat-tenant-isolation` | Live proof accepted with zero leakage | Sanitized two-company browser/API/MCP evidence JSON | Operator, Andrey/APS, and second company show `0` forbidden strings, `0` cross-tenant rows, `0` unauthorized search/API/MCP results | Pause onboarding; expire sessions; revoke test tokens; fix tenant boundary before retest |
| External tool canaries | `XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE`; strict runtime benchmark evidence; `XLOOOP_REQUIRE_EXTERNAL_DEFAULTS=1` only for promotion tests | `npm run canary:external-capabilities:live`; `npm run verify:upstream-capability-live-canary`; `npm run verify:external-capability-default-hard-stop` | `external_capability_default_authority=true` before any default enablement | Sanitized upstream canary and runtime benchmark reports | MarkItDown, Headroom, and Hyper-Extract-derived adapter logic pass live upstream and strict runtime gates | Keep MarkItDown canary-only, Headroom benchmark-only, Hyper-Extract restricted adapter/benchmark-only |

## Final Closeout

Run after the lane-specific evidence exists:

```bash
npm run verify:live-authority-inputs --silent
npm run verify:current-integrity --silent
npm run verify:production-hardening --silent
npm run verify:read-only-gates-do-not-dirty-worktree --silent
npm run verify:public-production-readiness-hard-stop -- --strict-public
npm run verify:dirty-worktree-classified --silent
git diff --check
git status --short
```

Expected result for external onboarding:

- `public_production_authority=true`
- `production_db_live_authority=true`
- `api_mcp_live_canary_authority=true`
- `public_self_serve_authority=true`
- `external_capability_default_authority=true` only if external tools are being
  default-enabled; otherwise they remain non-default and this is documented as
  an explicit product decision
- `0` forbidden customer-visible strings
- `0` cross-tenant rows/search hits/API/MCP results
- `0` unclassified dirty files

If any lane is missing, the correct state is `internal_controlled_validation`
only. Do not describe the system as external-onboarding-ready.
