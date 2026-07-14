# Public Self-Serve Evidence Gates

Public self-serve must stay blocked until the live-evidence gates below are configured with production-authoritative evidence. Synthetic/internal canary files are allowed for internal validation only.

## Delete/Export Object-Storage Receipt

Set `XLOOOP_DELETE_EXPORT_RECEIPT_FILE` to a JSON file with:

- `schema_id: xlooop.delete_export_object_storage_receipt.v1`
- `evidence_class: production_live_receipt`
- tenant/workspace scope
- approval id
- export/delete request ids
- audit id
- object key and SHA-256 hash
- export manifest SHA-256 hash
- retention class
- legal-hold state
- erasure/tombstone proof
- negative read-after-delete proof
- rollback boundary
- `raw_customer_data_used: false`
- `receipt_proofs` containing `object_storage_receipt_id`,
  `export_manifest_receipt_id`, `delete_request_receipt_id`,
  `legal_hold_receipt_id`, and `negative_read_receipt_id`
- no `synthetic`, `placeholder`, `example`, `redacted`, or `changeme`
  markers anywhere in a `production_live_receipt`
- parseable `action_executed_at` and `generated_at` timestamps, with
  `generated_at` no older than 7 days for public-production claims
- `verifier_command` referencing `verify:public-self-serve-production-receipts`
  so the receipt points back to the strict public authority gate

Verification:

```bash
XLOOOP_DELETE_EXPORT_RECEIPT_FILE=/path/to/receipt.json \
  npm run verify:delete-export-object-storage-execution -- --format=json

XLOOOP_DELETE_EXPORT_RECEIPT_FILE=/path/to/receipt.json \
  npm run verify:public-self-serve-production-receipts
```

`verify:delete-export-object-storage-execution` proves the lifecycle contract
shape. `verify:public-self-serve-production-receipts` is the strict promotion
gate and fails unless the receipt is `production_live_receipt`.

`synthetic_internal_canary` receipts may pass the contract but are not
public-self-serve authority.

Internal canary example:

```bash
XLOOOP_DELETE_EXPORT_RECEIPT_FILE=docs/deployment/evidence/latest-delete-export-object-storage-receipt.synthetic.json \
  npm run verify:delete-export-object-storage-execution
```

The same synthetic file must fail the strict public-self-serve gate.


## External Capability Default Hard Stop

MarkItDown, Hyper-Extract-derived logic, and Headroom must stay non-default until both evidence lanes pass:

- live upstream sandbox-canary evidence via `XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE`
- strict runtime benchmark evidence via `verify:external-capability-runtime-results -- --strict`
- tenant feature flag gate and owner approval gate in `docs/architecture/backend/EXTERNAL_CAPABILITY_REGISTRY.json`
- default enablement reviewed as a separate registry change

Internal controlled validation command:

```bash
npm run verify:external-capability-default-hard-stop
```

This passes when every capability remains disabled by default and reports
`external_capability_default_authority: false`. To test a future promotion path:

```bash
XLOOOP_REQUIRE_EXTERNAL_DEFAULTS=1 \
XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE=/path/to/live-upstream-results.json \
npm run verify:external-capability-default-hard-stop
```

Strict mode fails closed until live upstream canary and strict runtime benchmark evidence are both present.

Live upstream prerequisites are checked separately before strict default promotion:

```bash
npm run verify:external-capability-live-prereqs
XLOOOP_REQUIRE_EXTERNAL_DEFAULTS=1 npm run verify:external-capability-live-prereqs
```

Strict mode requires the sandbox venv, MarkItDown CLI, sandbox Python, package-source identity, and a supported Headroom compression API before any default-promotion decision. Current verified posture on 2026-06-22:

- MarkItDown: executable as an opt-in sandbox canary from `microsoft/markitdown` using Python 3.13 and `markitdown==0.1.6`; default adoption still requires full corpus coverage and strict runtime evidence.
- Headroom: not default-ready; the registry source `chopratejas/headroom` currently requires Cargo >=1.85 for Rust `edition2024`, and no supported `headroom.compress` API is available in the sandbox.
- Aggregate `--capability=all` canaries must fail closed if any selected capability reports result-level failures or `opt_in_canary_allowed: false`.

## Live Evidence Authority Matrix

The live-evidence authority matrix is the single summary gate for public-production claims. It consumes the specialist gates above and reports one `public_production_authority` boolean.

## Production DB Live Authority

Production/customer onboarding must stay blocked until database migration and
RLS authority are proven against live credentials. Configure both:

- `DATABASE_URL` for the target production Neon/Postgres owner/migration check
- `XLOOOP_RLS_APP_DATABASE_URL` for the non-owner app-role used by the app/API

Internal controlled validation command:

```bash
npm run verify:production-db-live-authority
```

This passes only as static/internal validation when live DB credentials are not
configured and reports `production_db_live_authority: false`. To enforce the
production promotion path:

```bash
XLOOOP_REQUIRE_PRODUCTION_DB_AUTHORITY=1 \
DATABASE_URL='postgresql://...' \
XLOOOP_RLS_APP_DATABASE_URL='postgresql://...' \
npm run verify:production-db-live-authority
```

Strict mode fails closed unless all migration files are recorded in
`workers_schema_version` and the non-owner app role proves RLS is enabled,
policy-backed, and not `BYPASSRLS`.

Internal controlled validation command:

```bash
npm run verify:live-evidence-authority-matrix
```

This passes only as internal validation while any authority lane is missing. To test a future public-production promotion path:

```bash
XLOOOP_REQUIRE_PUBLIC_PRODUCTION_AUTHORITY=1 \
DATABASE_URL='postgresql://...' \
XLOOOP_RLS_APP_DATABASE_URL='postgresql://...' \
XLOOOP_DELETE_EXPORT_RECEIPT_FILE=/path/to/production-live-receipt.json \
XLOOOP_REQUIRE_EXTERNAL_DEFAULTS=1 \
XLOOOP_UPSTREAM_CAPABILITY_RESULTS_FILE=/path/to/live-upstream-results.json \
XLOOOP_REQUIRE_API_MCP_LIVE_CANARY=1 \
XLOOOP_PARITY_PACKET_ID=pkt-canary-... \
XLOOOP_CANARY_API_TOKEN_FILE=/path/to/read-token.txt \
XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE=/path/to/lifecycle-token.txt \
npm run verify:live-evidence-authority-matrix
```

Strict mode fails closed until production DB, delete/export, external default,
and API/MCP live-canary authority are all present.

## Composed Public Production Hard Stop

Run the composed hard stop before any public/self-serve production claim. This
is the canonical public go/no-go source:

```bash
npm run verify:public-production-readiness-hard-stop -- --strict-public
```

Normal mode may pass for internal controlled validation while reporting
`public_self_serve_authority: false` until the production delete/export receipt
is present. Strict public mode fails until every live authority lane is present.
For the full closeout checklist, use
`docs/deployment/EXTERNAL_ONBOARDING_READINESS_CLOSEOUT.md`.

To test a focused public self-serve promotion path, run:

```bash
XLOOOP_REQUIRE_PUBLIC_SELF_SERVE=1 \
XLOOOP_DELETE_EXPORT_RECEIPT_FILE=/path/to/production-live-receipt.json \
npm run verify:public-production-readiness-hard-stop
```

The strict mode fails unless `verify:public-self-serve-production-receipts`
passes against a real `production_live_receipt`.

## API/MCP Live Canary Hard Stop

API/MCP customer-zero surfaces are statically wired, but live lifecycle parity
authority requires scoped canary evidence. Before claiming live parity, configure:

- `XLOOOP_PARITY_PACKET_ID` with a `pkt-canary-*` packet
- `XLOOOP_CANARY_API_TOKEN` or `XLOOOP_CANARY_API_TOKEN_FILE`
- `XLOOOP_CANARY_LIFECYCLE_API_TOKEN` or `XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE`
- `XLOOOP_API_BASE` when validating a non-default API endpoint

Internal controlled validation command:

```bash
npm run verify:api-mcp-live-canary-hard-stop
```

This passes when static/customer-zero boundaries are wired and reports
`api_mcp_live_canary_authority: false`. To test a future live-authority path:

```bash
XLOOOP_REQUIRE_API_MCP_LIVE_CANARY=1 \
XLOOOP_PARITY_PACKET_ID=pkt-canary-... \
XLOOOP_CANARY_API_TOKEN_FILE=/path/to/read-token.txt \
XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE=/path/to/lifecycle-token.txt \
npm run verify:api-mcp-live-canary-hard-stop
```

Strict mode fails closed unless the maintained API/MCP lifecycle parity verifier
passes with real scoped canary credentials.

## Hosted CI Runner Health

Hosted CI/account failures are tracked separately from product code-test
failures. The current evidence file is `data/hosted-ci-runner-health.json` and
is verified by:

```bash
npm run verify:hosted-ci-runner-health
```

MB-P hosted runs observed on 2026-06-22 failed before workflow steps executed
(`steps: []`, 2-3s duration). Xlooop-XCP-demo currently keeps active workflow
YAML disabled by policy, so local gates and Cloudflare direct-upload receipts
remain release authority until hosted CI is deliberately re-enabled.

## Two-Company Live Pilot Evidence

Set `XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE` to JSON matching:

- `schema_id: xlooop.two_company_live_pilot_evidence.v1`
- `evidence_class: external_live_pilot`
- duration at least `24` hours
- two or more companies with customer-only employees
- per-company `source_evidence` with provider, source connection id,
  workspace id, connected/synced status, connected/synced timestamps,
  emitted source-event count `>=1`, latest source-event timestamp, and
  source audit ids
- cross-tenant leakage `0`
- unapproved writes `0`
- raw graph exposure `0`
- forbidden surface exposure `0`
- revocation bypass `0`
- auth regression `0`
- API/MCP safety regression `0`
- audit coverage `100`

Example shape: `docs/deployment/evidence/two-company-live-pilot-evidence.schema.example.json`.
Files ending in `.example.json` or `schema.example.json` are contract examples
only; the live authority verifier rejects them as public pilot authority even
when their shape is valid.

Verification:

```bash
XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE=/path/to/two-company-live-pilot.json \
  npm run verify:two-company-live-pilot-evidence -- --format=json
```

`internal_synthetic_canary` evidence may pass the schema contract but is not public-self-serve authority.
If APS/ASP, Honest & Young, or other customer accounts have already been used
for validation, record that as controlled-validation evidence unless the JSON
points to a real 24-48h external run, uses `evidence_class: external_live_pilot`,
has per-company source connection and source-event lineage, and is exported
through `XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE`. The blocker is not "no
companies exist"; it is "no authoritative source-linked two-company evidence
packet is configured and passing."

## Upstream Capability Live Canary

Run the live upstream canary from an installed sandbox venv:

```bash
npm run canary:external-capabilities:live -- \
  --capability=all \
  --format=json \
  --output=/private/tmp/xlooop-external-capability-live-upstream-results.json

npm run verify:upstream-capability-live-canary -- \
  --format=json \
  --live-input=/private/tmp/xlooop-external-capability-live-upstream-results.json
```

Default adoption remains blocked unless the strict runtime verifier passes on live evidence and the owner explicitly approves default enablement.

Latest committed summary: `docs/deployment/evidence/latest-upstream-capability-live-canary-summary.json`.
