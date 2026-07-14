# ASP — First real customer provisioning runbook

**Goal:** stand up **Access Property Services (ASP)** as a Clerk-org-scoped customer
tenant end-to-end, with no operator data exposure and no terminal/psql step in the normal
onboarding lane.

**Status:** superseded by Clerk-first/API-first onboarding after the 2026-06-22 tenant
boundary incident. This runbook is retained for traceability, but the active path is:

1. approve the access request,
2. invite the customer to the Clerk org,
3. let `/api/v1/session` auto-provision on first accepted org-scoped login when
   `CUSTOMER_AUTO_PROVISION_ON_SESSION=true`, or
4. use the admin endpoint `POST /api/v1/admin/access-requests/:id/provision`.

For operator-created Clerk organizations, the smoother path is now available behind an
explicit production flag: when `CUSTOMER_AUTO_PROVISION_FROM_CLERK_ORG=true` and
`CUSTOMER_AUTO_PROVISION_APPROVER_USER_ID` (or `MBP_OWNER_USER_ID`) is configured,
the first accepted org-scoped session may create/approve the access request and provision
the workspace in one audited path. The approver id is required so the audit trail never
pretends the customer approved themselves.

`npm run onboard-customer`, direct `psql`, and manual entitlement inserts are break-glass
fallbacks only. They are not the standard onboarding process.

> **ASP is the right first customer:** its inspection-report data fits the existing
> 5-connector roster (Drive/OneDrive/Dropbox) — **zero new connector engineering**.
> (H&Y / accounting needs a Xero connector first — a separate track.)

---

## Active automation contract

1. **Clerk org + owner invite remains the human/admin action until a Clerk webhook or
   admin UI creates orgs directly.** The Clerk org id is the customer workspace id.
2. **Provisioning is automatic after invite acceptance.** On first org-scoped login,
   `/api/v1/session` may call `provisionCustomerFromAccessRequest` when
   `CUSTOMER_AUTO_PROVISION_ON_SESSION=true`, the access request is `invited`, the email
   matches, and `invited_to_workspace_id` equals the active Clerk org id.
3. **Operator-created Clerk orgs can skip pre-created access requests.** When
   `CUSTOMER_AUTO_PROVISION_FROM_CLERK_ORG=true`, `/api/v1/session` may create a
   `source='clerk-org-session-auto-provision'` access request, mark it `invited` with the
   configured operator approver id, and provision the workspace. This is the best UX path
   for customers added directly in Clerk.
4. **Admin endpoint is the fallback normal API lane.** If first-session auto-provisioning
   is disabled or missed, use `POST /api/v1/admin/access-requests/:id/provision`. Do not
   use local terminal onboarding unless the API lane is unavailable and the owner approves
   a break-glass data fix.
5. **Manual entitlement SQL is not a customer onboarding step.** Entitlement rows must be
   created by governed API/service code or a separately approved data repair, with an
   immutable audit receipt.

---

## Sequence

| # | Who | What | Lands in |
|---|-----|------|----------|
| 1 | ASP | submit access request | `access_requests` (`pending`) + `readiness_assessments` |
| 2 | operator | review pending | — |
| 3 | operator | approve | `access_requests.status='invited'` + `audit_logs` |
| 4 | operator | **Clerk** create org + invite owner | Clerk org `org_…` + owner `user_…` |
| 5 | app/API | auto-provision on first accepted org login; if no access request exists, use the guarded Clerk-org session path; admin API provision fallback only if missed | `access_requests`+`workspaces`+`users`+`workspace_members`+`projects`+`operation_events`+operator-side `customer_authority_consents` |
| 6 | ASP | sign typed-name consent | customer-side `customer_authority_consents` → **authority unlocked** |
| 7 | verifier | tenant isolation + authority + MCP/API gates | `0` forbidden strings, `0` cross-tenant rows, scoped read-only API/MCP |

---

### Step 1 — ASP submits the access request  · *ASP (or operator on their behalf)*
```bash
curl -s -X POST https://api.xlooop.com/api/v1/request-access \
  -H 'content-type: application/json' \
  -d '{"email":"<asp-owner@…>","account_type":"company",
       "company_name":"Access Property Services","deep_level":3,
       "readiness_answers":{},"source":"x-web-readiness-register"}'
# -> 202 {request_id, status:"pending"} · idempotent on email
```
**Verify:** `SELECT id,email,status FROM access_requests WHERE email='<asp email>';` → `pending`.
`src/workers/routes/request-access.ts:54`.

### Step 2 — Operator reviews  · *operator (admin JWT)*
```bash
curl -s https://api.xlooop.com/api/v1/admin/access-requests?status=pending \
  -H "authorization: Bearer <ADMIN_JWT>"
# capture the ASP request_id
```
`src/workers/routes/admin.ts:46`.

### Step 3 — Operator approves  · *operator (admin JWT)*
```bash
curl -s -X POST https://api.xlooop.com/api/v1/admin/access-requests/<request_id>/approve \
  -H "authorization: Bearer <ADMIN_JWT>" -H 'content-type: application/json' -d '{}'
# sets access_requests.status='invited' (NOT 'approved'); writes audit_logs; emails ASP
# CLI equivalent: DATABASE_URL=… npm run admin:approve <request_id>
```
**Verify:** `SELECT status FROM access_requests WHERE id='<request_id>';` → `invited`.
`admin.ts:84` → `access-store.ts:143`.

### Step 4 — **MANUAL** Clerk org + owner invite  · *operator (Clerk dashboard)*
> No code path. The Clerk **org id becomes the workspace id**.
1. Clerk dashboard → **Organizations → Create** `Access Property Services` → copy **`org_…`**.
2. **Members → Invite** the ASP owner email → owner **accepts** + **signs in once** → copy their **`user_…`**.

**Verify:** the org exists; the owner is an accepted member. Keep `clerk_org_id` + `owner_clerk_id`.
`admin.ts:108-109`, `customer-provisioning-store.ts:7-10`.

### Step 5 — Provision the workspace  · *first-session fallback or operator admin API*

Preferred path:
1. Customer accepts the Clerk org invite.
2. Customer signs in with the Clerk org active.
3. `/api/v1/session` auto-provisions when `CUSTOMER_AUTO_PROVISION_ON_SESSION=true`.
4. If the operator created the Clerk org/member without a prior access request,
   `/api/v1/session` also auto-creates the request when
   `CUSTOMER_AUTO_PROVISION_FROM_CLERK_ORG=true` and an audited approver id is configured.

Admin API fallback:
```bash
curl -s -X POST https://api.xlooop.com/api/v1/admin/access-requests/<request_id>/provision \
  -H "authorization: Bearer <ADMIN_JWT>" -H 'content-type: application/json' \
  -d '{"clerk_org_id":"org_…","owner_clerk_id":"user_…",
       "project_name":"Access Property Services · Operations"}'
# 201 -> writes workspaces+users+workspace_members+projects+operation_events
#        + the OPERATOR side of customer_authority_consents (operator_approved_at)
# clerk_org_id must match ^org_[A-Za-z0-9]{5,}$ ; owner_clerk_id ^user_[A-Za-z0-9]{5,}$ (admin.ts:136)
# CLI fallback is break-glass only: npm run onboard-customer is not the happy path.
```
**Verify:**
```sql
SELECT count(*) FROM workspaces WHERE id='org_…';                    -- 1
SELECT count(*) FROM projects   WHERE workspace_id='org_…';          -- 1
SELECT count(*) FROM customer_authority_consents
  WHERE workspace_id='org_…' AND operator_approved_at IS NOT NULL;   -- 1
```
`admin.ts:124` → `onboarding-provisioner.ts:116` → `customer-provisioning-store.ts:54` (operator authority INSERT `:101-106`, mirrors `customer-template.sql §5b`).

### Step 6 — ASP owner signs the typed-name consent  · *ASP (signed in)*
> ⚠️ Requires the **org-scoping fix** (this branch) deployed, so the owner's token carries `org_id`.
1. ASP owner signs in → `https://app.xlooop.com/?screen=customer-authority-consent`
2. reviews the 8 data-authority scopes → **types full legal name** → *Consent and unlock workspace*.
```
POST https://api.xlooop.com/api/v1/customer/authority-consent   (xlooop-workers JWT; org from claim)
body: {"full_name_typed":"<owner legal name>","scopes_confirmed":{…8 keys=true}}
-> 202 {authority:{unlocked:true,operator_approved:true,consent_acked:true}}
```
**Verify:**
```sql
SELECT operator_approved_at IS NOT NULL AS op, consent_acked_at IS NOT NULL AS cust, full_name_typed
FROM customer_authority_consents WHERE workspace_id='org_…' AND revoked_at IS NULL;  -- op=t, cust=t
```
Connectors + invites now stop returning `403 AUTHORITY_REQUIRED`.
`CustomerAuthorityConsent.jsx:32` → `customer.ts:32` → `customer-authority-store.ts:46` (unlocked predicate `:103`).

### Step 7 — Verify tenant and authority gates  · *operator/verifier*

Do not call the onboarding complete until all customer-visible surfaces show only the ASP
workspace/project and the API/MCP read-only gates pass.

```bash
npm run verify:customer-chat-tenant-isolation
npm run verify:tenant-search-isolation
npm run verify:new-user-onboarding-isolation
npm run verify:new-user-api-mcp-onboarding-scenario
npm run verify:customer-onboarding-composed-gate
```

Acceptance:
- forbidden customer-visible strings: `0`
- cross-tenant rows/search hits: `0`
- unauthorized API/MCP results: `0`
- public self-serve remains blocked until live delete/export, two-company pilot, and
  upstream capability canary receipts are present.

---

## Posture guard (before you call this "a customer")

Per `data/production-pilot-readiness.json`, a **controlled commercial walkthrough /
pilot_discovery** posture is permitted; an **autonomous private-operator pilot is not**
until the strict paid-pilot boundary receipt passes against this real ASP tenant. Keep
`must_not_say` discipline: **no "production SaaS", no "signed pilot terms ready"** until
the operator sets posture and the strict receipt is green.
