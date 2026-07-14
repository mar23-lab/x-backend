# AUTH_TENANCY_MODEL · Clerk + Multi-Tenancy Design

**Status:** DRAFT — ready for implementation  
**Date:** 2026-05-26  
**Authority:** BACKEND_ADR_001.md stack decision  
**Applies to:** Clerk Auth + Cloudflare Workers JWT validation + Neon Postgres tenant isolation

---

## Core model

**One Clerk organization = one Xlooop workspace = one tenant.**

Clerk handles:
- User identity (sign-up, login, sessions, MFA)
- Organization management (create, invite, role assignment)
- JWT issuance (signed tokens per session, scoped to org)

Xlooop backend handles:
- JWT validation (verify signature against Clerk JWKS)
- Tenant data isolation (all DB queries include `WHERE workspace_id = $1` from JWT `org_id`)
- Role-based data visibility (RBAC enforced at SQL layer per API_CONTRACT_V1.md)

---

## Clerk setup (operator actions required)

### 1. Create Clerk application

1. Sign up at dashboard.clerk.com
2. Create a new application: **"Xlooop"**
3. Enable **Organizations** feature (Clerk Pro required for >3 orgs; free tier allows 3)
4. Set allowed redirect URLs: `https://*.xlooop.com`, `http://localhost:*` (dev)

### 2. Configure JWT claims

In Clerk Dashboard → JWT Templates, create a template named **"xlooop-workers"** with custom claims:

```json
{
  "email": "{{user.primary_email_address}}",
  "name": "{{user.full_name}}",
  "org_id": "{{org.id}}",
  "org_role": "{{org.role}}",
  "org_slug": "{{org.slug}}",
  "org_name": "{{org.name}}"
}
```

These map to Xlooop's RBAC model:
- `email` → required by session-first auto-provisioning to create an auditable `access_requests` row
- `name` → preferred display name for first-login owner/member setup
- `org_id` → `workspace_id` in every DB query
- `org_role` → maps to Xlooop role (see table below)
- `org_slug` / `org_name` → customer workspace slug/display fallback

If Clerk does not expose `{{org.name}}` in your dashboard, omit only `org_name`; keep `email`,
`org_id`, `org_role`, and `org_slug`. Without `email`, first-login provisioning fails closed and the
user remains in `pending_access` until an operator provisions the DB rows manually.

### 3. Clerk role → Xlooop role mapping

| Clerk org_role | Xlooop role | DB visibility |
|---|---|---|
| `org:admin` | `owner` | All visibility levels including `internal_owner_only` |
| `org:admin` | `operator` | `internal_workspace`, `internal_project`, `public_safe` |
| `org:member` | `viewer` | `internal_project`, `public_safe` |
| `org:member` (client tag) | `client` | `public_safe` only |

**Day 1 simplification:** `org:admin` = owner/operator (full access). `org:member` = viewer. No sub-role tagging until customer 3+.

### 4. Environment variables (Cloudflare Workers secrets)

Set via `wrangler secret put`:

```bash
CLERK_SECRET_KEY=sk_live_...
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_JWKS_URL=https://your-app.clerk.accounts.dev/.well-known/jwks.json
CLERK_JWKS_CACHE_TTL_SECONDS=300
```

---

## JWT validation flow (per-request in CF Workers)

```
Request → Authorization: Bearer <jwt>
    ↓
Worker: fetch JWKS from Clerk (cached in-memory, TTL=300s)
    ↓
Verify JWT signature + expiry
    ↓
Extract claims: { sub, org_id, org_role, exp }
    ↓
Map org_role → xlooop_role
    ↓
Inject { user_id, workspace_id, role } into request context
    ↓
All DB queries: WHERE workspace_id = $1
```

**No session storage** — JWT validation is stateless. Every request is independently verified.

**JWKS caching** — fetch JWKS once per 5 minutes (configurable). Cold start: fetch before first auth. Cache key: `jwks:${CLERK_JWKS_URL}`.

---

## Scoped canary service principal

**Purpose:** API/MCP parity and customer-zero canary validation only. This is
not a customer impersonation mechanism and not a replacement for Clerk/OAuth.

Normal product users continue to enter through Clerk JWTs. The canary service
principal is accepted only on the backend operational spine and MCP gateway:

- `GET /api/v1/mcp/tools`
- read-only packet/status/metrics/projection checks under the operational spine
- audited canary evidence/tool-event paths only when the route-level RBAC permits it

The canary is intentionally configured as:

```json
{
  "user_id": "svc_xlooop_canary",
  "role": "viewer",
  "workspace_id": "<fixed XLOOOP_CANARY_WORKSPACE_ID>"
}
```

Because the role is `viewer`, existing route-level guards keep it read-only.
It cannot create packets, submit evidence, request approvals, report tool
events, record metric deltas, or execute customer lifecycle actions unless a
future route explicitly changes that policy with separate approval.

### Forbidden surfaces

The canary service principal must never expose or invoke:

- customer impersonation
- raw graph export
- full tenant memory
- Xlooop internal templates
- governance scoring
- agent routing
- private graph schema
- secrets
- admin actions
- destructive delete/export
- broad search-all-memory

### Secrets and local use

Only the token hash is stored in Workers. The raw token is local/operator-held
and must not be committed.

Generate a local canary token and hash:

```bash
TOKEN="$(openssl rand -base64 48 | tr -d '\n')"
printf '%s' "$TOKEN" > /tmp/xlooop-canary-api-token.txt
chmod 600 /tmp/xlooop-canary-api-token.txt
printf '%s' "$TOKEN" | shasum -a 256
unset TOKEN
```

Set Worker secrets:

```bash
npx wrangler secret put XLOOOP_CANARY_API_TOKEN_SHA256
npx wrangler secret put XLOOOP_CANARY_WORKSPACE_ID
```

Run the API/MCP parity verifier without a short-lived browser JWT:

```bash
XLOOOP_API_BASE=https://api.xlooop.com \
XLOOOP_CANARY_API_TOKEN="$(cat /tmp/xlooop-canary-api-token.txt)" \
npm run verify:api-mcp-parity -- --transport=all --format=json
```

If an exact packet identity check is required, also set:

```bash
export XLOOOP_PARITY_PACKET_ID=<scoped_packet_id>
```

---

## Tenant isolation guarantees

### Database layer (hard enforcement)

Every query in `WorkersDalAdapter` enforces isolation:

```sql
-- Events query (enforces workspace isolation + visibility)
SELECT * FROM operation_events
WHERE workspace_id = $1          -- from JWT org_id
  AND visibility = ANY($2)       -- from role-visibility map
  AND archived_at IS NULL
ORDER BY occurred_at DESC
LIMIT $3;

-- Sign-off (validates event belongs to workspace before insert)
INSERT INTO sign_offs (workspace_id, event_id, user_id, verdict, comment)
SELECT $1, $2, $3, $4, $5
WHERE EXISTS (
  SELECT 1 FROM operation_events
  WHERE id = $2 AND workspace_id = $1  -- cross-tenant check
);
```

**No cross-tenant queries are possible** at the SQL layer. The `workspace_id` column has an index on every table. Missing `workspace_id` in any query is a deployment blocker.

### Application layer (defense in depth)

- `WorkersDalAdapter` methods all accept `workspaceId` as first parameter
- Methods throw if `workspaceId` is empty/null
- Route handlers validate JWT before calling any DAL method
- No route handler stores or passes `workspaceId` beyond the single request scope

---

## Workspace provisioning (customer onboarding flow)

### Step 1: Create Clerk organization (operator action)

1. In Clerk Dashboard → Organizations → Create organization
2. Set org name: `<Customer> Corp`
3. Note the org ID: `org_<clerk_id>`
4. Invite the customer's operator user email

### Step 2: Seed the database (admin script)

Run the seed SQL from `DATABASE_SCHEMA_V1.md`:

```sql
-- Create workspace record (maps to Clerk org)
INSERT INTO workspaces (id, name, owner_user_id, slug)
VALUES ('org_<clerk_id>', '<Customer Name>', 'user_<owner_clerk_id>', '<customer-slug>');

-- Add operator member
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('org_<clerk_id>', 'user_<operator_clerk_id>', 'operator');

-- Create initial project
INSERT INTO projects (id, workspace_id, name)
VALUES ('proj_<nanoid>', 'org_<clerk_id>', '<Project Name>');
```

### Step 3: Verify access

```bash
# Get a JWT for the new org member (via Clerk test token)
# Call the session endpoint
curl -H "Authorization: Bearer <jwt>" https://api.xlooop.com/api/v1/session
# Should return workspace + projects for the new customer only
```

---

## Invite flow

Day 1 invites are managed entirely through Clerk's built-in invite system:

1. **Operator sends invite** → Clerk Dashboard → Organizations → `<org>` → Members → Invite
2. **Invitee receives email** → Clerk-hosted sign-up/sign-in flow
3. **First login** → Clerk issues org-scoped JWT → worker validates → user can access workspace

No custom invite UI needed on Day 1. Clerk handles email delivery, link expiry, and role assignment.

**Day 2 (when needed):** custom invite UI in the Xlooop app that calls Clerk's invitation API. This is a pure UI change; no backend or DB change required.

---

## RBAC enforcement matrix

| Endpoint | owner | operator | viewer | client |
|---|---|---|---|---|
| GET /health | ✓ | ✓ | ✓ | ✓ |
| GET /session | ✓ | ✓ | ✓ | ✓ |
| GET /events | ✓ (all) | ✓ (ws+proj+pub) | ✓ (proj+pub) | ✓ (pub only) |
| POST /events | ✓ | ✓ | ✗ | ✗ |
| GET /projects | ✓ | ✓ | ✓ | ✗ |
| GET /board-cards | ✓ | ✓ | ✓ | ✗ |
| POST /sign-offs | ✓ | ✓ | ✗ | ✗ |

**Enforcement location:** DB query (visibility filter) for GET /events; JWT role check + 403 for write endpoints.

---

## Security hardening (Day 1 production)

### HTTPS everywhere
- Cloudflare terminates TLS — no HTTP in production
- Workers only accessible via `https://api.xlooop.com`
- Clerk JWKS fetched over HTTPS

### JWT expiry
- Clerk default: 60 seconds (short-lived for security)
- Session tokens refreshed automatically by Clerk.js on the frontend
- Workers validate `exp` claim on every request

### CORS lockdown
- `Access-Control-Allow-Origin: https://*.xlooop.com`
- No `*` wildcard in production
- Preflight caching: 24 hours (`Access-Control-Max-Age: 86400`)

### Rate limiting
- Per-IP + per-workspace (see API_CONTRACT_V1.md)
- Clerk handles brute-force protection on sign-in

### Secret rotation
- `CLERK_SECRET_KEY` can be rotated via `wrangler secret put` without downtime
- JWKS URL is public (no secret); cache invalidates on TTL

---

## Multi-customer isolation verification checklist

Before onboarding each customer:

- [ ] `workspace_id` is the Clerk org ID (not an internal ID) — verified in seed SQL
- [ ] All API calls from customer A's JWT return only customer A's data (test with curl)
- [ ] Customer B's JWT cannot access customer A's events (403 or empty result)
- [ ] Sign-off transaction includes cross-workspace guard (WHERE workspace_id = $1)
- [ ] Clerk org is set to private (not discoverable by non-members)
- [ ] No hardcoded workspace IDs in the codebase

---

## Scaling path (4+ customers)

| Customers | Clerk plan | Neon plan | Monthly cost |
|---|---|---|---|
| 1–3 | Free (3 orgs) | Free (0.5 GB) | $0 |
| 4+ | Pro ($25/mo) | Free → Pro ($19) | $25–$44/mo |
| 10+ | Pro (included) | Pro | $44/mo |
| Enterprise | Custom | Custom | TBD |

**Trigger for Clerk Pro:** onboarding customer 4. Create the upgrade ticket when customer 3 signs.
**Trigger for Neon Pro:** approaching 500k rows or 0.5 GB storage (estimate: ~6 months at current growth).

---

# Entitlement model (R40 · 2026-05-26)

**Core principle:** Clerk proves identity. Neon authorizes access. A valid Clerk session **does NOT automatically grant product access**.

## Tables added in R40

| Table | Purpose |
|---|---|
| `users` | Neon mirror of Clerk users with `status: pending\|approved\|rejected\|suspended` + `is_admin` flag |
| `access_requests` | Public "request-to-try" funnel — admin reviews + invites via Clerk separately |
| `audit_logs` | Append-only record of admin actions |
| `workspace_members.status` (NEW COLUMN) | Per-membership approval gate (`pending\|active\|revoked\|suspended`) |

## Session endpoint state machine (`GET /api/v1/session`)

| Condition | Response state | HTTP |
|---|---|---|
| Missing/invalid JWT | (early-exit) | 401 |
| Valid JWT + `users.status = rejected\|suspended` | `access_denied` | 200 |
| Valid JWT + `users.status = pending` | `pending_access` | 200 |
| Valid JWT + approved user + no Clerk org context | `authenticated_no_access` | 200 |
| Valid JWT + approved user + Clerk org but no active membership | `authenticated_no_access` | 200 |
| Valid JWT + approved user + active membership | `approved_workspace` (full data) | 200 |

The frontend reads the `state` field and shows the appropriate screen. All non-approved states return EMPTY workspace + projects fields.

## Onboarding paths

### Path A · Direct invite (customers 1+2)

1. Admin creates Clerk Organization for the customer
2. Admin invites operator via Clerk
3. After invite acceptance, run `npm run onboard-customer` which seeds:
   - `users` row with `status='approved'`
   - `workspace_members` row with `status='active'`
   - Initial project + welcome event + 5 audit log entries

### Path B · Public access request (early adopters)

1. Public visitor hits `POST /api/v1/request-access` with `{email, company_name, reason}`
2. Backend writes `access_requests` row with `status='pending'`, captures IP + UA
3. Admin notification (R40 stub: Workers Logs; R41: Resend email)
4. Admin reviews via CLI: `DATABASE_URL='…' npm run admin:list` then `npm run admin:approve <req_id>`
5. After approval, admin invites the user via Clerk + runs `onboard-customer`

`POST /request-access` writes NO user row, NO workspace, NO membership. Just an `access_requests` row in `status=pending`.

## Admin identity

Two ways a user becomes admin:

1. **Env-var allowlist:** `ADMIN_USER_IDS` CSV in `wrangler.toml` `[vars]` or `.dev.vars`
2. **DB flag:** `users.is_admin = true`

Middleware checks env-var first (fast), then DB.

## Clerk dashboard settings to enforce now

1. **Disable Clerk public sign-up.** User & Authentication → Sign-up: **disabled**
2. **Set Membership = "Required"** so personal sessions can't exist
3. **Restrict org creation** to admin role only

## Email notifications

R40 stub logs to Workers Logs. R41 wires Resend: set `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `ADMIN_NOTIFICATION_EMAIL` env vars and the stub switches to real email with no code change.

## Operator-owned orgs vs customer orgs (W4/G2 · 2026-06-15)

The IP-boundary authority gate (`customer_authority_consents`, `unlocked = consent_acked AND operator_approved`) applies to **every** workspace with a Clerk `org_id`. But the operator's OWN orgs and real CUSTOMER orgs need different treatment:

- **Operator-owned orgs** — the operator IS the authority for their own workspaces, so a separate manual operator-approval (DR-11) is pure friction (it dead-ended "connect my own Drive"). When the consenter records consent, the operator-approval side is **auto-recorded** so the workspace unlocks self-serve.
- **Customer orgs** — unchanged: connectors stay locked until the operator explicitly approves (`POST /api/v1/admin/customer/:workspace_id/approve`, which records the operator side). This is the real IP boundary.

**Scope is set by `OPERATOR_WORKSPACE_IDS`** (wrangler.toml `[vars]`, comma-separated `org_` ids). The consent route auto-approves iff `auth.workspace_id ∈ OPERATOR_WORKSPACE_IDS`. When the allowlist is unset it falls back to a consenter-is-operator heuristic (`MBP_OWNER_USER_ID` + linked) for backwards-compat. The allowlist is the precise, org-keyed criterion — it does NOT auto-approve a customer org even if the operator happens to be the one consenting in it.

### Deferred follow-up (G10) — Clerk OAuth provider health check
A `GET /api/v1/admin/health/connectors` that lists the Clerk instance's *configured* `oauth_*` apps and diffs them against `CONNECTOR_REGISTRY` (turning a missing-OAuth-app from a runtime 502 into a pre-flight signal) is **not yet built** — it needs a new Clerk backend-API integration (the worker has no provider-listing call today). Tracked for a follow-up; the registry↔frontend SSOT drift gate (`verify-connector-provider-ssot.mjs`) and the live connect verification cover the rest.
