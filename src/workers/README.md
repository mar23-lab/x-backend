# src/workers — Xlooop Production API (Cloudflare Workers)

This directory contains the production REST API for Xlooop. It implements the contracts defined in:

- `docs/architecture/backend/BACKEND_ADR_001.md` — stack decision
- `docs/architecture/backend/API_CONTRACT_V1.md` — 7 REST endpoints + error envelopes
- `docs/architecture/backend/AUTH_TENANCY_MODEL.md` — Clerk auth + tenant isolation
- `docs/architecture/backend/DATABASE_SCHEMA_V1.md` — Neon Postgres schema
- `docs/architecture/backend/BACKEND_ROLE_DEFINITION.md` — agent role + constraints

## Directory layout

```
src/workers/
├── index.ts                # Hono app entry · wires routes + middleware + DAL
├── middleware/
│   ├── auth.ts             # Clerk JWT validation (JWKS-cached)
│   ├── cors.ts             # CORS lockdown to https://*.xlooop.com
│   └── error.ts            # Error envelope formatter
├── routes/
│   ├── health.ts           # GET /api/v1/health (no auth)
│   ├── session.ts          # GET /api/v1/session
│   ├── events.ts           # GET + POST /api/v1/events
│   ├── projects.ts         # GET /api/v1/projects
│   ├── board-cards.ts      # GET /api/v1/board-cards
│   └── sign-offs.ts        # POST /api/v1/sign-offs
├── dal/
│   ├── types.ts            # Shared types (matches API_CONTRACT_V1)
│   ├── DalAdapter.ts       # Backend-agnostic interface (ADR-V3-002)
│   ├── visibility.ts       # Pure role→visibility-set mapping
│   └── WorkersDalAdapter.ts# Concrete Neon impl (ONLY file referencing Neon)
├── db/
│   ├── client.ts           # Neon serverless HTTP client
│   └── migrations/
│       ├── 001_init.sql    # Initial schema (idempotent)
│       └── README.md       # Migration workflow
└── __tests__/
    ├── health.test.ts      # Smoke test for /health
    ├── auth.test.ts        # Auth middleware contract tests
    └── visibility.test.ts  # Pure-function visibility tests
```

## Quickstart (after operator does the one-time setup below)

```bash
# 1. Install dependencies (adds hono, neon, clerk, nanoid)
npm install

# 2. Typecheck the workers code
npm run typecheck:workers

# 3. Run smoke tests
npx tsx src/workers/__tests__/visibility.test.ts
npx tsx src/workers/__tests__/health.test.ts
npx tsx src/workers/__tests__/auth.test.ts

# 4. Start local dev server (reads .dev.vars for secrets)
npm run dev:api
#   → http://localhost:8787/api/v1/health returns 200

# 5. Deploy preview (dry-run, no upload)
npm run deploy:api:dryrun

# 6. Deploy to production (after operator wires custom domain in CF Dashboard)
npm run deploy:api
```

## One-time operator setup

See `docs/handoffs/round39-backend-scaffold-operator-actions.md` for the full checklist. Summary:

1. **Sign up Neon** → create project `xlooop-production` → run `001_init.sql` on a dev branch → promote to main
2. **Sign up Clerk** → create app `Xlooop` → enable Organizations → add JWT template `xlooop-workers` with claims `email`, `name`, `org_id`, `org_role`, `org_slug` (`org_name` optional)
3. **Set Workers secrets:**
   ```bash
   wrangler secret put DATABASE_URL --config wrangler.toml
   wrangler secret put CLERK_SECRET_KEY --config wrangler.toml
   wrangler secret put CLERK_PUBLISHABLE_KEY --config wrangler.toml
   ```
4. **Local dev:** copy `.dev.vars.example` to `.dev.vars` and fill in test keys
5. **DNS:** in Cloudflare Dashboard → Workers → `xlooop-api` → Custom Domains → add `api.xlooop.com`
6. **Verify:** `curl https://api.xlooop.com/api/v1/health` returns `{"status":"ok",...}`

## Hard rules (per BACKEND_ROLE_DEFINITION.md)

- **DAL is the only Neon caller.** Routes call `ctx.get('dal').<method>()`, never `neon()` directly.
- **Every query is workspace-scoped.** `assertWorkspaceScope()` runs at the top of every adapter method.
- **Migrations are additive.** Never `DROP COLUMN` or `DROP TABLE` — add new columns/tables.
- **No frontend globals.** Workers run in V8 isolates; `window`/`document` are not available.
- **Secrets via `wrangler secret put`.** Never commit values to git or `wrangler.toml`.

## Adding a new endpoint

1. Add the spec to `docs/architecture/backend/API_CONTRACT_V1.md`
2. Add the method to `dal/DalAdapter.ts` (additive only)
3. Implement in `dal/WorkersDalAdapter.ts`
4. Create the route handler in `routes/<name>.ts`
5. Mount in `index.ts` under `protectedRoutes` (auth + org required), `adminRoutes` (auth + admin), or directly under `app` (public)
6. Add a contract test in `__tests__/`

## R40 · Entitlement gate (added 2026-05-26)

The backend now gates all product access on a Neon-side `users.status = 'approved'` + active `workspace_members` row. Clerk identity is necessary but not sufficient.

- `routes/session.ts` — state machine returning one of `approved_workspace` / `authenticated_no_access` / `pending_access` / `access_denied`
- `routes/request-access.ts` — public funnel for early-adopter access requests
- `routes/admin.ts` — admin-only endpoints for list/approve/reject access requests + users
- `middleware/admin.ts` — `requireAdmin()` via env-var `ADMIN_USER_IDS` or `users.is_admin`
- `services/email-notifier.ts` — admin notification stub (Workers Logs now; Resend in R41)
- `scripts/admin-access.mjs` — CLI for offline admin (`npm run admin:list`, etc.)

See `docs/architecture/backend/AUTH_TENANCY_MODEL.md` §Entitlement model for the full design.

## R40 · Testing

```
npm run test:workers              # runs vitest under workerd
```

Suites:
- `entitlement.test.ts` — 6 scenarios from AUTH_TENANCY_MODEL.md
- `request-access.test.ts` — validation, idempotency, admin gate
- `health.test.ts` — health endpoint
- `auth.test.ts` — JWT validation contract
- `visibility.test.ts` — role → visibility mapping
