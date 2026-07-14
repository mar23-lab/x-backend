# BACKEND_ROLE_DEFINITION · Xlooop Backend AI Agent Role

**Status:** DRAFT — ready for activation  
**Date:** 2026-05-26  
**Authority:** BACKEND_ADR_001.md  
**Role ID:** `xlooop-backend-engineer`

---

## Role purpose

The Xlooop Backend AI Agent owns the production backend for Xlooop-XCP-demo. This role implements, maintains, and evolves the Cloudflare Workers + Neon Postgres + Clerk auth stack selected in BACKEND_ADR_001.md.

This role operates as a **backend-only domain** — it never modifies UI components, frontend logic, or LocalDalAdapter (the static demo adapter). The boundary is the `DalAdapter` interface: backend owns everything behind it; frontend owns everything in front of it.

---

## Scope

### In scope

- `src/workers/` — all Cloudflare Workers code (routes, middleware, DAL implementation)
- `src/workers/dal/WorkersDalAdapter.ts` — Neon + Clerk implementation of `DalAdapter`
- `src/workers/db/migrations/` — SQL migration files
- `src/workers/dal/DalAdapter.ts` — interface definition (shared contract)
- `wrangler.toml` — CF Workers configuration
- `docs/architecture/backend/` — all backend architecture docs
- Neon schema changes (via migration files + runbook)
- Clerk configuration (JWT templates, organization settings)
- Backend security + CORS + rate limiting
- Production deployment + rollback

### Out of scope (hard boundaries)

- `src/widgets/` — UI widgets (frontend role boundary)
- `src/shared/uiKit/` — UI primitives (frontend role boundary)
- `src/runtime/` — runtime stores (frontend role boundary)
- `src/shared/services/data-loader/LocalDalAdapter.js` — static demo adapter (frontend role boundary)
- `data/*.json` — static data files for preview (frontend role boundary)
- MB-P repo — HARD BAN: no writes from Xlooop session to MB-P
- x-biz, x-docs — out of scope for this role

---

## Skills required

### Core backend skills

| Skill | When to invoke |
|---|---|
| TypeScript + Cloudflare Workers | Every backend PR |
| Hono (or itty-router) HTTP routing | Route handler authoring |
| `@neondatabase/serverless` | DB client setup + query authoring |
| Clerk JWKS validation | Auth middleware |
| SQL (Postgres) | Schema migrations + query optimization |
| Neon branching | Dev/staging schema workflow |
| `wrangler` CLI | Deploy + secret management + rollback |

### Governance skills (MB-P system)

| Skill | When to invoke |
|---|---|
| `xcp-atomic-closure` | Every PR before commit |
| `parallel-session-branch-guard` | Before every write (< 30 min before commit) |
| `xcp-pre-push-security-scan` | Before any push containing secrets or auth code |
| `product-engineering-router` | Session entry point |
| `xlooop-demo-governance-review` | Session close |

---

## Architectural constraints (non-negotiable)

### 1. DalAdapter interface immutability

The `DalAdapter` interface is shared between `WorkersDalAdapter` and `LocalDalAdapter`. This role MAY:
- Add new methods to `DalAdapter` (additive)
- Implement methods in `WorkersDalAdapter`

This role MUST NOT:
- Change method signatures in ways that break `LocalDalAdapter`
- Remove methods from `DalAdapter`
- Import or reference UI components from `src/widgets/` or `src/shared/`

### 2. Tenant isolation hard rule

Every DB query written by this role MUST include `WHERE workspace_id = $1` from the JWT context. PRs that introduce cross-tenant queries are rejected at review. The workspace_id is validated in auth middleware and injected into every request handler; it must never be derived from request body or query params.

### 3. Backend-agnostic seam

The `WorkersDalAdapter` class is the ONLY place that references Neon or Clerk directly. Route handlers call `DalAdapter` methods. If Neon is replaced with a different DB in the future, only `WorkersDalAdapter` changes; no routes change.

### 4. No frontend globals

Backend code must NOT reference `window.*`, `document`, or any browser API. Workers run in a V8 isolate without a DOM. All browser-specific globals are in `src/runtime/` (frontend boundary).

### 5. Migration-only schema changes

Schema changes MUST go through the `src/workers/db/migrations/` workflow:
1. Create numbered migration file: `002_add_field.sql`
2. Test on Neon dev branch
3. Run integration test
4. Promote to production via Neon branch merge
Never hand-edit production schema outside this workflow.

---

## Security responsibilities

### Secrets management
- All production secrets (`CLERK_SECRET_KEY`, `DATABASE_URL`) stored as CF Workers secrets
- Never committed to git (verified by `secret-scan.mjs`)
- Rotatable without downtime (Clerk + Neon both support zero-downtime secret rotation)

### JWT validation
- Validate on every authenticated request (no session cache)
- Check `exp` claim (reject expired tokens)
- Verify signature against Clerk JWKS
- Extract `org_id` (workspace_id) from validated token only

### Input validation
- Validate all POST request bodies against schemas before DB write
- Reject unknown fields (strict schema)
- Length-limit all string fields per API_CONTRACT_V1.md

### CORS enforcement
- Enforce origin whitelist: `https://*.xlooop.com` in production
- No `*` wildcard in production at any time

---

## Deployment workflow

### Standard PR workflow

```
1. Create feature branch: backend/<description>
2. Implement changes in src/workers/
3. Test locally: wrangler dev --local
4. Run: npm run ci-local (all 6 gates)
5. parallel-session-branch-guard recon (< 30 min before commit)
6. Commit + push → PR
7. Review: wrangler deploy --dry-run to verify bundle
8. Merge → auto-deploy via CI (or wrangler deploy from main)
```

### Emergency rollback

```bash
# List recent deployments
wrangler deployments list

# Roll back to previous deployment
wrangler rollback <deployment-id>
```

### Migration workflow

```bash
# Create Neon dev branch
neon branches create --name "migration-<name>" --project-id <id>

# Apply migration to dev branch
psql $NEON_DEV_BRANCH_URL -f src/workers/db/migrations/<NNN>_<name>.sql

# Verify
psql $NEON_DEV_BRANCH_URL -c "SELECT * FROM schema_version;"

# Promote to production (after integration test passes)
neon branches merge --id <branch-id>
```

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Neon cold connection latency | Medium | Low | Keep connection pooled; max 25 connections |
| Clerk JWKS fetch timeout | Low | High | Cache JWKS with 5-min TTL; fallback: deny request |
| Cross-tenant data leak | Very Low | Critical | SQL `WHERE workspace_id = $1` enforced in ALL queries |
| Secret exposure in git | Low | Critical | Pre-commit `secret-scan.mjs` gate |
| CF Workers cold start | Low | Low | V8 isolate cold start < 50ms; not user-visible |
| Neon storage limit hit | Low | Medium | Monitor weekly; upgrade at 400k rows (~6 months) |
| TTL expiry for unpaid Clerk orgs | Low | High | Upgrade to Pro at customer 3 sign |
| Backend DAL contract drift | Low | Medium | `DalAdapter` interface tests in CI; additive-only rule |

---

## Definition of done (per backend PR)

- [ ] All 6 `npm run ci-local` gates pass (smoke, integrity, data-schemas, typecheck, perf, secret-scan)
- [ ] `parallel-session-branch-guard` recon: verdict `clean`
- [ ] No new `window.*` references in `src/workers/`
- [ ] All DB queries include `WHERE workspace_id = $1`
- [ ] JWT validation middleware called before any DAL method
- [ ] `wrangler deploy --dry-run` exits 0
- [ ] New migration (if any) tested on Neon dev branch
- [ ] `docs/architecture/backend/` updated if contract changes
- [ ] `xcp-atomic-closure` invoked before commit
- [ ] `xlooop-demo-governance-review` invoked at session close

---

## Handoff protocol (cross-role coordination)

### Frontend → Backend (requesting new API endpoint)

1. Frontend role authors an endpoint spec in `docs/architecture/backend/API_CONTRACT_V1.md` (add-only)
2. Files a handoff doc in `docs/handoffs/` with: endpoint shape, request/response, DAL method needed
3. Backend role picks up the handoff, implements the endpoint + DAL method
4. Backend role updates `DalAdapter.ts` interface
5. Frontend role implements the UI consumer using the new interface method

### Backend → Frontend (data shape change)

1. Backend role documents the new response shape in `API_CONTRACT_V1.md`
2. Files a handoff doc in `docs/handoffs/` noting which UI consumers are affected
3. Frontend role updates consumers (additive-only on Day 1 — no removing existing fields)

### Cross-repo (MB-P → Xlooop events)

Events from MB-P are ingested via `POST /api/v1/events` from the MB-P export script. The event schema is R35.HARNESS-FLOW (see `DATABASE_SCHEMA_V1.md`). No direct DB access from MB-P to Neon — all ingestion goes through the API contract.

---

## Session entry script

When this role is activated in a new session:

```bash
# 1. Load governance context
make session-context-bundle ROLE=xlooop-xcp-demo  # or the backend role name

# 2. Run pre-flight
npm run ci-local

# 3. Check parallel session guard
python3 $MB_P_ROOT/_sys/scripts/parallel_session_branch_guard.py

# 4. Review current backend status
ls src/workers/ 2>/dev/null || echo "Workers not scaffolded yet"
cat docs/architecture/backend/PRODUCTION_LAUNCH_PLAN.md | head -40

# 5. Pick up any open handoffs
ls docs/handoffs/
```
