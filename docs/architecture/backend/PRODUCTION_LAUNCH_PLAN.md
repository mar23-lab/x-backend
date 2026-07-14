# PRODUCTION_LAUNCH_PLAN · Customers 1+2 Now, Then 3+4

**Status:** DRAFT — ready for execution  
**Date:** 2026-05-26  
**Authority:** BACKEND_ADR_001.md + AUTH_TENANCY_MODEL.md  
**Target:** 2 paying customers live within 3 weeks · 2 more within 6 weeks

---

## Current state (baseline)

| Layer | Status |
|---|---|
| Frontend (Xlooop-XCP-demo) | Live in static preview mode (LocalDalAdapter) |
| Backend (Cloudflare Workers) | Not deployed — scaffold needed |
| Database (Neon Postgres) | Not provisioned |
| Auth (Clerk) | Not configured |
| Domain (api.xlooop.com) | Not wired |
| Customers 1+2 | Ready to onboard NOW |

**Zero infrastructure delta for existing preview** — the current static demo continues to work unchanged. Backend deployment is additive.

---

## Phase A · Infrastructure Setup (Days 1–3)

### A.1 — Neon Postgres provisioning

**Operator action:**
1. Sign up at neon.tech (free tier)
2. Create project: `xlooop-production`
3. Create dev branch: `schema-v1-init`
4. Run schema DDL from `DATABASE_SCHEMA_V1.md`:
   ```bash
   psql $NEON_DEV_BRANCH_URL -f docs/architecture/backend/DATABASE_SCHEMA_V1.md
   ```
5. Verify all 7 tables created + all indexes present
6. Promote dev branch to main (Neon branching UI)
7. Copy `DATABASE_URL` to `.env.production` (NOT committed to git)

**Deliverable:** Neon project with full schema on main branch.

### A.2 — Clerk application setup

**Operator action:**
1. Sign up at clerk.com (free tier — up to 3 orgs)
2. Create application: `Xlooop`
3. Enable Organizations feature
4. Configure JWT template `xlooop-workers` (see AUTH_TENANCY_MODEL.md §Clerk setup)
5. Set allowed redirect URLs
6. Copy `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWKS_URL` to `.env.production`

**Deliverable:** Clerk app with Organizations enabled + JWT template configured.

### A.3 — Cloudflare Workers scaffold

**Agent action (backend AI role):**
1. Create `src/workers/` directory structure:
   ```
   src/workers/
   ├── index.ts              # Router entry point (Hono or itty-router)
   ├── middleware/
   │   ├── auth.ts           # JWT validation via Clerk JWKS
   │   └── cors.ts           # CORS policy from API_CONTRACT_V1.md
   ├── routes/
   │   ├── health.ts
   │   ├── session.ts
   │   ├── events.ts
   │   ├── projects.ts
   │   ├── board-cards.ts
   │   └── sign-offs.ts
   ├── dal/
   │   ├── DalAdapter.ts     # Interface (existing ADR-V3-002)
   │   ├── WorkersDalAdapter.ts  # Neon + Clerk implementation
   │   └── LocalDalAdapter.ts   # Dev stub (existing)
   └── db/
       ├── client.ts         # Neon serverless client setup
       └── migrations/
           └── 001_init.sql  # Copy of DATABASE_SCHEMA_V1.md DDL
   ```
2. Configure `wrangler.toml` with production routes + compatibility date
3. Set Cloudflare Workers secrets via `wrangler secret put`
4. Deploy to `api.xlooop.com` (custom domain in CF Dashboard)

**Deliverable:** `npm run deploy:workers` exits 0 · `GET https://api.xlooop.com/api/v1/health` returns 200.

### A.4 — DNS + domain wiring

**Operator action:**
1. In Cloudflare Dashboard → Workers → `xlooop-api` → Triggers → Custom Domains
2. Add: `api.xlooop.com`
3. Verify DNS propagation: `dig api.xlooop.com` shows Cloudflare IPs
4. Test: `curl https://api.xlooop.com/api/v1/health` → `{"status":"ok"}`

**Deliverable:** `api.xlooop.com` resolves and returns health check.

---

## Phase B · Customer 1 Onboarding (Days 4–7)

### B.1 — Create Customer 1 Clerk organization

**Operator action:**
1. Clerk Dashboard → Organizations → Create
2. Name: `<Customer 1 Name>`
3. Note org ID: `org_<clerk_id>`
4. Invite customer's operator email as `org:admin`
5. Invite additional team members as `org:member`

### B.2 — Seed Customer 1 database

**Agent action (backend AI role):**
Run seed script:
```sql
INSERT INTO workspaces (id, name, owner_user_id, slug)
VALUES ('org_<clerk_id>', '<Customer 1 Name>', 'user_<owner_id>', '<slug>');

INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('org_<clerk_id>', 'user_<operator_id>', 'operator');

INSERT INTO projects (id, workspace_id, name)
VALUES ('proj_<nanoid>', 'org_<clerk_id>', '<Project Name>');
```

### B.3 — Frontend DAL switch

**Agent action (frontend/backend AI role):**

The UI currently uses `LocalDalAdapter`. Switch to `WorkersDalAdapter` by updating the DAL factory:

```typescript
// src/dal/factory.ts
const adapter = process.env.VITE_USE_WORKERS_DAL === 'true'
  ? new WorkersDalAdapter({ baseUrl: 'https://api.xlooop.com' })
  : new LocalDalAdapter();
```

Set `VITE_USE_WORKERS_DAL=true` in the production build.

**Zero UI change** — the switch is a single config flag. All components continue to call the same `DalAdapter` interface.

### B.4 — Customer 1 acceptance test

**Operator-driven verification:**
1. Customer logs in via Clerk-hosted sign-in
2. Sees their workspace (empty → seed with initial event)
3. Events stream populates from live backend
4. Operator sign-off creates `sign_offs` row + updates `approval_state`
5. Second browser as different org → sees ZERO data from Customer 1 (isolation verified)

**Go/no-go gate:** all 5 checks pass → Customer 1 is live.

---

## Phase C · Customer 2 Onboarding (Days 8–10)

Mirrors Phase B exactly. Estimated wall-clock: 2–3 hours operator time.

**Key difference from Customer 1:** no infrastructure changes — Neon, Workers, and domain are already live. Only org + DB seed + acceptance test.

**Deliverable:** 2 paying customers live on shared infrastructure · zero additional cost (still within Clerk free tier 3-org limit + Neon free tier).

---

## Phase D · Harden Before Customers 3+4 (Days 11–18)

After customers 1+2 are live and stable:

### D.1 — Observability

- Enable Cloudflare Workers logs (Dashboard → Workers → Logs)
- Set up Cloudflare Analytics for the workers route
- Create a simple Neon query for daily event ingestion count:
  ```sql
  SELECT workspace_id, COUNT(*) as events_today
  FROM operation_events
  WHERE ingested_at >= NOW() - INTERVAL '24 hours'
  GROUP BY workspace_id;
  ```

### D.2 — Error alerting

- Cloudflare Email Routing → alert on 5xx spike
- Target: receive alert when 5xx rate > 1% in any 5-minute window
- Implementation: Cloudflare Workers Analytics → Email (Workers free tier includes basic alerting)

### D.3 — Backup verification

- Neon automatic backups: enabled by default on free tier (point-in-time recovery to 7 days)
- Verify: Neon Dashboard → Backups → confirm latest backup timestamp < 24h ago
- Test restore to dev branch: `neon branches create --name restore-test`

### D.4 — Load test (optional but recommended)

- Simulate 4-customer load: 4 workspaces × 100 events/day × polling every 30s
- Tool: `k6` or `curl` loop
- Target: p95 < 500ms for GET /api/v1/events with 50 rows returned

### D.5 — Upgrade Clerk to Pro

- Trigger: onboarding Customer 3 hits the 3-org free limit
- Action: Clerk Dashboard → Billing → Upgrade to Pro ($25/mo)
- No downtime, no code changes

---

## Phase E · Customers 3+4 Onboarding (Days 19–21)

Mirrors Phases B+C. By this point:
- Clerk Pro is active (4+ orgs supported)
- Workers are battle-tested by Customers 1+2
- Observability is live

Each new customer: ~2 hours operator time (Clerk org + DB seed + acceptance test).

---

## Cost summary at full 4-customer deployment

| Service | Plan | Cost |
|---|---|---|
| Cloudflare Workers | Free (100k req/day) | $0 |
| Neon Postgres | Free (0.5 GB, ~60k rows) | $0 |
| Clerk Auth | Pro (4+ orgs) | $25/mo |
| **Total** | | **$25/mo** |

**Upgrade triggers:**
- Neon Pro ($19/mo): when approaching 500k rows or 0.5 GB (~6 months at current growth)
- Cloudflare Workers Paid ($5/mo): when exceeding 100k requests/day (unlikely until 20+ customers)

---

## Rollback plan

If production issues arise post-deploy:

1. **Revert DAL switch:** set `VITE_USE_WORKERS_DAL=false` → rebuild → redeploy static → back to `LocalDalAdapter` in minutes
2. **Workers issue:** `wrangler rollback` to previous deployment
3. **Database issue:** Neon point-in-time restore to pre-issue timestamp

**The static demo is always a safe fallback** — it runs independently of the backend and can be served without any backend infrastructure.

---

## Pre-launch checklist

### Infrastructure
- [ ] Neon schema deployed + all 7 tables present
- [ ] Clerk app created + Organizations enabled + JWT template configured
- [ ] Workers deployed to `api.xlooop.com`
- [ ] `GET https://api.xlooop.com/api/v1/health` returns 200
- [ ] CORS headers present in response

### Security
- [ ] `CLERK_SECRET_KEY` stored as CF Workers secret (not in code)
- [ ] No hardcoded workspace IDs in codebase
- [ ] Cross-tenant isolation verified (two browsers, two orgs, zero data leak)
- [ ] JWT expiry < 5 minutes

### Performance
- [ ] GET /api/v1/events p95 < 500ms on cold Neon connection
- [ ] Workers cold start < 50ms (V8 isolate, no Node.js startup)

### Operations
- [ ] Cloudflare Workers logs enabled
- [ ] Neon backup timestamp verified
- [ ] Rollback plan documented and tested in dev

**All items checked → Customer 1 onboarding begins.**
