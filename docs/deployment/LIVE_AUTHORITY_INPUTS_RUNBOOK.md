# Live-authority inputs runbook — the 4 fail-closed lanes (T5/P8 · 260710)

**What this is:** `verify:public-production-readiness-hard-stop --strict-public` correctly FAILS today
because four authority lanes need REAL operator-provisioned inputs (no synthetic/example/redacted evidence
can satisfy them — the gates reject placeholder markers by design). This runbook maps each lane to the exact
named input, its verify command, and its freshness window, so provisioning is a checklist, not archaeology.
**No lane is executed by an agent** — every input below is operator-named. Owner: Marat.

| # | Lane | Named input(s) | Verify command | Freshness |
|---|---|---|---|---|
| 1 | **Delete / export / legal-hold receipt** | `XLOOOP_DELETE_EXPORT_RECEIPT_FILE` → a REAL production receipt JSON (object key · tenant · actor · timestamps · legal-hold state · delete/export result · `receipt_proofs` for object-storage, export manifest, delete request, legal hold, negative read) | `npm run verify:public-self-serve-production-receipts` | ≤ 7 days at claim time |
| 2 | **API / MCP live canary** | `XLOOOP_PARITY_PACKET_ID` + scoped read/lifecycle canary credentials (a real customer-token minted via `POST /developer-access/tokens` once flags are enabled) | the API/MCP canary lane inside `verify:live-authority-inputs` | ≤ 14 days |
| 3 | **Two-company pilot evidence** | `XLOOOP_TWO_COMPANY_PILOT_EVIDENCE_FILE` → source-linked packets for the REAL controlled-validation tenants (APS/ASP + Honest & Young): per company `source_evidence` = provider · connection/sync status · workspace binding · event count · latest event timestamp · audit/source receipt ids | `npm run verify:two-company-live-pilot-evidence` (strict) | per gate config |
| 4 | **Production DB / RLS authority** | live `DATABASE_URL` + `XLOOOP_RLS_APP_DATABASE_URL` (the RLS-subject app role) | the DB/RLS lane inside `verify:live-authority-inputs` (tenant-isolation + non-owner-denied probes) | at claim time |

**The one preflight to run first:** `node scripts/verify-live-authority-inputs.mjs` — it reports
`lane_readiness` per lane (which inputs are missing) BEFORE interpreting strict-public failures, so the next
operator action is always obvious. The hard stop stays fail-closed until all four lanes pass with live
inputs; `internal_safety_failure_count=0` is the healthy state while inputs are absent.

**Sequence relative to the program:** these lanes gate the PUBLIC/self-serve production claim only. They do
NOT gate the operator-named cutover sequence (frontend sign-off → deploy held app → apply migrations 057–060
→ ordered flags → §5g probe → `ENTITLEMENT_ENFORCEMENT` flip), which remains governed by
`DESIGN_DECISIONS_REGISTER.md` D-1/D-12/D-13.
