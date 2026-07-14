# Customer Connector Token + Hosted MCP — Activation Runbook

Operator runbook to turn on the customer connector feature shipped in #742 (scoped
revocable tokens), #743 (honest "Copy setup"), and #744 (hosted MCP endpoint). The feature
is **inert on `main`** — nothing below happens until you run these steps deliberately.

> Why this is a runbook and not automated: every step here is a **production gate** — a prod
> DB write, a prod secret, real customer/DPA data, or a live-client smoke. They are operator
> actions by design.

## What shipped (code, merged, gates green)
- `src/workers/db/migrations/037_customer_api_tokens.sql` — hash-only, revocable token table.
- `src/workers/dal/customer-token-store.ts` + DAL wiring — token CRUD.
- `src/workers/middleware/auth.ts` `customerTokenAuth` — DB-backed service-token auth (inert unless flag on).
- `src/workers/routes/developer-access.ts` — `POST/GET/DELETE /api/v1/developer-access/tokens` (human owner/operator only, flag-gated).
- `src/workers/routes/mcp-gateway.ts` — per-customer write sandbox.
- `src/workers/routes/mcp-rpc.ts` — `POST /api/v1/mcp/rpc` native MCP (Streamable HTTP/JSON-RPC), read-only tools, dispatches to the REST handlers.
- Verifiers: `verify:customer-connector-token-safety`, `verify:customer-mcp-rpc-contract`.

## Activation order (each step gates the next)

### 1. Apply migration 037 to prod Neon  (prod DB write)
Project `flat-truth-23350426` ("Xlooop"). The table is additive + idempotent (`CREATE TABLE IF
NOT EXISTS`); creating it has **zero runtime effect** until step 2.

```sql
-- verify-before: expect workspaces_fk_target_exists=t, token_table_already_exists=f
SELECT to_regclass('public.workspaces') IS NOT NULL,
       to_regclass('public.customer_api_tokens') IS NOT NULL;

-- apply (exact DDL is in migrations/037_customer_api_tokens.sql)
\i src/workers/db/migrations/037_customer_api_tokens.sql

-- verify-after: expect 1 table + 2 indexes
SELECT count(*) FROM information_schema.tables  WHERE table_name='customer_api_tokens';
SELECT indexname FROM pg_indexes WHERE tablename='customer_api_tokens';
```
Rollback: `DROP TABLE customer_api_tokens;` (safe — nothing references it until step 2).

### 2. Enable the read-only flag  (prod secret/var)
```bash
# read-only viewer tokens + customerTokenAuth become active (no tokens exist yet, so still inert in practice)
wrangler secret put CUSTOMER_API_TOKENS_ENABLED   # value: true
# (leave CUSTOMER_OPERATIONAL_TOKENS_ENABLED unset until step 6)
```
Rollback: `wrangler secret delete CUSTOMER_API_TOKENS_ENABLED` (auth path goes inert again).

### 3. Provision Honest & Young  (real data — not fabricated)
- Add the user to the Honest & Young Clerk org with role `admin` (→ owner/operator).
- Record the signed DPA date + `pilot_user_id` + `onboarding_date` in
  `_sys/.../PILOT_USER_REGISTRY.md` (MB-P) and flip status → `active`.

### 4. Mint a viewer token  (human owner/operator session)
```bash
curl -s -X POST https://api.xlooop.com/api/v1/developer-access/tokens \
  -H "Authorization: Bearer <owner-clerk-jwt>" \
  -H "content-type: application/json" \
  -d '{"role":"viewer","label":"Claude Code · read-only"}'
# → { token: "xlk_ro_…", token_id, expires_at, connect: { whoami_check } }   (token shown ONCE)
```

### 5. Smoke the live connection  (the verification only the live endpoint can give)
```bash
# A. direct REST
curl -s https://api.xlooop.com/api/v1/mcp/whoami -H "Authorization: Bearer xlk_ro_…"
#    expect: xlooop.mcp_whoami.v1, allowed_tools = 5, no forbidden surface.

# B. native MCP (the #744 endpoint)
claude mcp add --transport http xlooop https://api.xlooop.com/api/v1/mcp/rpc \
  --header "Authorization: Bearer xlk_ro_…"
#    then in Claude Code: call xlooop.whoami → confirm identity + workspace.
```

### 6. (Later, after proofs) Enable operator/write tokens
Only after the **token-revocation proof** and **two-company-isolation proof** pass:
```bash
wrangler secret put CUSTOMER_OPERATIONAL_TOKENS_ENABLED   # value: true
```
Operator-role tokens then mint; writes are still confined to the customer's own workspace
packets (`ensureCustomerWriteScope`) and gated by `canWrite`.

### Revocation drill (the revocation proof)
```bash
curl -s -X DELETE https://api.xlooop.com/api/v1/developer-access/tokens/<token_id> \
  -H "Authorization: Bearer <owner-clerk-jwt>"
# then re-run step 5A → expect 401 (revoked token fails closed).
```

## Pre-activation verification (already green on main)
- `npm run verify:customer-connector-token-safety` · `npm run verify:customer-mcp-rpc-contract`
- `npx vitest run --config vitest.workers.config.ts src/workers/__tests__/mcp-rpc-route.test.ts` (9 tests)
- `npm run typecheck`

## Notes
- The gateway is REST; native `claude mcp add` works via the #744 hosted MCP endpoint
  (`/api/v1/mcp/rpc`), which re-dispatches to the same REST handlers — tools stay single-sourced.
- Tokens are stored hash-only (SHA-256), mandatory expiry, instant revocation via `revoked_at`.
- Customer tokens reach only the operational MCP surface, never admin/product routes.
