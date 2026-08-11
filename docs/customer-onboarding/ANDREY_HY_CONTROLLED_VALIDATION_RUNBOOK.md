# Andrey/APS And Honest & Young Controlled Validation

## Authority And Scope

This runbook collects the source-linked 24-48 hour two-company evidence required
for public self-serve review. It does not authorize production deployment or
replace customer consent. The two companies must use distinct tenants,
workspaces, customer-only employee accounts, credentials, connector bindings,
and audit chains.

The pilot may start only after the internal company A/B canary, API/MCP lifecycle
parity, customer revocation, and lifecycle receipt gates pass against the exact
staging build. Record the ratified backend SHA, schema, contract hash, frontend
SHA, rollback tuple, and pilot start audit id before inviting either company.

## Start Receipt

Create a reviewed observation file outside Git. It must begin with:

- `evidence_class: external_live_pilot`
- one UTC `started_at` timestamp, plus the operator-local Australia/Melbourne time
- Andrey/APS and Honest & Young company, tenant, workspace, and customer employee refs
- source connection, consent, workspace binding, and initial sync audit ids
- the staging backend/frontend/contract tuple and rollback target

Never put raw customer content, OAuth credentials, connector tokens, or private
graph data in the observation file. Store only identifiers, hashes, counts,
statuses, timestamps, and redacted receipts.

## 24-48 Hour Checks

At start, midpoint, and close, collect source-linked evidence for both companies:

1. Fresh customer login reaches only the expected tenant and workspace.
2. `xlooop.whoami` returns the expected tenant, role, scopes, and token expiry.
3. Source connection remains `connected`; sync is `synced` or `completed`.
4. At least one governed source event is visible in the correct workspace.
5. Cross-tenant packet, search, API, and MCP reads are denied or return zero rows.
6. Evidence submission, tool event, approval request, and metric receipt are audited.
7. Revoking the test connector blocks every subsequent customer API/MCP operation.
8. Customer UI exposes no diagnostics, raw graph, MB-P internals, forbidden surface,
   seeded demo answer, or deterministic conversational success.

The observation must prove:

- cross-tenant leakage: `0`
- cross-tenant search hits: `0`
- unapproved writes: `0`
- raw graph and forbidden surface exposure: `0`
- revocation bypass and auth/API/MCP safety regressions: `0`
- audit coverage: `100%`

## Close And Finalize

Set `ended_at` only after at least 24 real hours have elapsed. The builder derives
duration from `started_at` and `ended_at`; it refuses a future end time, a run
shorter than 24 hours, an example output path, or an external claim without the
reviewed `external_live_pilot` class.

```bash
npm run create:two-company-live-pilot -- \
  --input=/private/path/reviewed-two-company-observations.json \
  --output=/private/path/two-company-live-pilot-evidence.json \
  --external-live --format=json

XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE=/private/path/two-company-live-pilot-evidence.json \
XLOOOP_REQUIRE_TWO_COMPANY_LIVE_PILOT=1 \
  npm run verify:two-company-live-pilot-evidence -- --format=json
```

The final receipt must include complete company source evidence, operator/customer
checks, API/MCP checks, zero safety metrics, and audit ids. A synthetic fixture,
schema example, shortened clock, or manually asserted duration is not public
authority.

## Stop And Roll Back

Pause both tenants, revoke pilot credentials, and preserve audit evidence if any
tenant leak, raw/internal exposure, unapproved write, revocation bypass, auth
regression, missing source lineage, or audit gap occurs. Roll back to the ratified
staging tuple, open an RCA, convert the prevention into a gate, and rerun the full
internal company A/B canary before resuming the external pilot.
