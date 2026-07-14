# BACKEND_ADR_001 · Stack Decision · Cloudflare Workers + Neon Postgres + Clerk Auth

**Status:** ACCEPTED  
**Date:** 2026-05-26  
**Decision-makers:** Marat  
**Urgency:** 2 paying customers ready to onboard NOW · 2 more immediately after  
**Cross-links:** [ADR-V3-002](../../adrs/ADR-V3-002-dal-adapters.md) · [ADR-V3-004](../../adrs/ADR-V3-004-multi-tenant-identity.md) · [ADR-V3-015](../../adrs/ADR-V3-015-cross-repo-http-boundary.md) · [R35.API-RT](../../audits/operator-stability/api-vs-realtime-decision.md)

---

## Context

Xlooop-XCP-demo has reached TRUE STEADY STATE on the frontend (R29–R38 arc · 6/6 CI gates · 526/526 smoke · 0 known-fails). The product gap is: **no backend exists**. Two paying customers are ready to onboard immediately. This ADR decides the production stack.

### Key constraints

- **Already on Cloudflare** — domains, Pages, DNS already use CF; Workers deployment adds zero infrastructure delta
- **Backend-agnostic** per ADR-V3-002 — UI never references a specific DB or auth provider directly
- **Low-cost** — first 4 customers must cost < $50/mo total
- **Speed** — customers 1+2 onboard in 3 weeks, not 3 months
- **Swappable** — stack decision must not prevent migration to a different provider later

---

## Decision

**Stack: Cloudflare Workers + Neon Postgres + Clerk Auth**

| Layer | Technology | Why | Cost (4 customers) |
|---|---|---|---|
| **Runtime / API** | Cloudflare Workers | Already on Cloudflare; V8 isolate; global edge; 100k req/day free | $0 Free / $5 Paid |
| **Database** | Neon Postgres | Serverless Postgres; auto-suspend; branching for dev/migrations; 0.5 GB free tier; standard SQL | $0 Free / $19 Pro |
| **Auth + tenancy** | Clerk | Organizations = tenants out of the box; user management UI included; <10k MAU free; JWT works natively with Workers | $0 Free / $25 Pro |
| **TOTAL** | | | **$0 – $49/mo** |

---

## Architecture

```
Browser (Xlooop frontend — existing esbuild bundle, no UI change required)
  │
  ├── GET  /api/v1/health         → 200 OK
  ├── GET  /api/v1/session        → Clerk JWT → workspace context
  ├── GET  /api/v1/events         → Neon: operation_events (tenant-scoped)
  ├── POST /api/v1/events         → Neon: insert event (auth required)
  ├── GET  /api/v1/projects       → Neon: projects (tenant-scoped)
  ├── GET  /api/v1/board-cards    → Neon: board_cards (tenant-scoped)
  ├── POST /api/v1/sign-offs      → Neon: sign_offs (auth required)
  ├── GET/POST /api/v1/packets    → Neon: task_packets (safe task packets)
  ├── GET/POST /api/v1/evidence   → Neon: evidence_items (evidence callbacks)
  ├── GET/POST/PATCH /api/v1/approvals → Neon: approval_requests
  ├── GET/POST /api/v1/tool-events     → Neon: tool_events (MCP/tool reports)
  ├── GET/POST /api/v1/metric-deltas   → Neon: metric_deltas
  └── GET/POST /api/v1/mcp/*           → safe signed packet/evidence gateway
        │
        ▼
  Cloudflare Worker (src/workers/api/)
        │
        ├── Clerk SDK — JWT verify + org/user claim extraction
        │
        └── @neondatabase/serverless — HTTP-mode Postgres queries
              └── Neon Postgres (DATABASE_SCHEMA_V1.md)
```

### Backend-agnostic seam (ADR-V3-002 DAL adapter — existing pattern)

The frontend never imports Clerk, Neon, or Workers SDK. All reads/writes flow through the existing `XcpDataProjectionReader` which delegates to a `WorkersDalAdapter`:

```
DalAdapter interface (ADR-V3-002 — existing):
  readOperationsLiveStream(workspaceId) → EventRow[]
  readProjection(workspaceId)           → ProjectionView
  writeEvent(envelope)                  → EventId
  readWorkspace(workspaceId)            → WorkspaceView
  readProjects(workspaceId)             → ProjectRow[]
  create/list TaskPacket                → scoped execution packet
  create/list EvidenceItem              → governed evidence callback
  create/decide/list ApprovalRequest    → approval workflow
  create/list ToolEvent                 → safe MCP/tool report
  create/list MetricDelta               → measured outcome

Implementations:
  LocalDalAdapter    — current state (localStorage + static JSON)
  WorkersDalAdapter  — Phase A (Cloudflare Workers REST → Neon Postgres)
  // Future: SupabaseDalAdapter, SelfHostedPostgresAdapter, ConvexDalAdapter
```

Frontend switches from `LocalDalAdapter` to `WorkersDalAdapter` via a single config flag. Zero UI component changes.

### Phase 2 operational spine

The backend also owns the customer-safe operational spine:

- **Safe projections:** session, workspace, projects, board cards, packets, events, evidence, approvals, and metrics.
- **Allowed execution boundary:** scoped packets, event reports, evidence callbacks, approval requests, tool-event reports, and metric deltas.
- **Private server-side core:** raw graph, full tenant memory, Xlooop internal templates, governance scoring, agent routing, private graph schema, secrets, and broad search-all-memory tools.

Codex, Claude, MCP, and future execution clients consume scoped packets and report evidence/tool events. They do not receive raw graph or full memory access.

The safe MCP gateway is mounted at `/api/v1/mcp/*`. It is a narrow execution
client surface over the operational spine:

- `GET /mcp/tools` returns the safe tool manifest and forbidden surfaces.
- `GET /mcp/task-packets/:id` returns a signed packet envelope.
- `POST /mcp/evidence`, `/mcp/tool-events`, and `/mcp/approval-requests` write
  only packet-scoped operational evidence.
- `GET /mcp/status?packet_id=...` returns packet-scoped evidence, approvals,
  tool events, and metric deltas.

It must fail closed if packet signing is not configured and must not expose raw
graph, full tenant memory, internal templates, governance scoring, agent
routing, private graph schema, secrets, or broad search-all-memory tools.

Customer data lifecycle execution is modeled through the same spine. Export and
delete requests create approval records first; execution requires an approved
request and emits metadata-only evidence plus tool-event audit rows. Delete
execution archives the scoped target packet and keeps the audit trail. It is not
a raw hard-delete of governance history, tenant memory, or platform internals.

---

## Transport decisions (per R35.API-RT channel matrix)

| Data class | Phase 1 (launch) | Phase 2 | Phase 3 |
|---|---|---|---|
| Auth / session | REST stateless JWT | same | same |
| Workspace / projects / board | REST GET on demand | + optimistic writes | same |
| OperationsLiveStream | Polling at 30 s | SSE if < 5 s freshness required | WebSocket only if bidirectional |
| Agent activity | Polling at 30 s | SSE | same |
| Writes (events, sign-offs) | REST POST | same | same |

**WebSocket is NOT in scope for customers 1–4.**  
**SSE is Phase 2** — only when operator UX requires sub-5 s freshness.

---

## Security

1. All endpoints require `Authorization: Bearer <clerk-jwt>` except `/health`
2. Every DB query is scoped to `workspace_id` from JWT org claim — no cross-tenant reads possible at query layer
3. CORS: locked to `*.xlooop.com` in production (not `*`)
4. Secrets: `wrangler secret put` only — never in git
5. Rate limiting: Cloudflare edge rate limiting (no application code needed)
6. Write endpoints require `role IN ('owner', 'operator')` from Clerk org membership
7. Phase 2 operational spine tables have RLS-ready policies and same-workspace relationship triggers. Query-layer tenant scoping remains the active production guard until live DB transaction context supports `FORCE ROW LEVEL SECURITY`.
8. Customer data lifecycle execution requires approval, RLS-scoped backend execution, and metadata-only receipts. Full irreversible storage erasure is a separate retention workflow and must preserve legal/audit obligations.

---

## Container strategy

Workers = V8 isolates, NOT Docker containers. Containers appear only in:

| Context | Technology | Purpose |
|---|---|---|
| Local dev | Docker Compose (Postgres 16 + Miniflare 3) | Mirror production schema locally without Neon account |
| CI | GitHub Actions with Docker Postgres service | Schema migration tests + integration tests |
| Future migration | Docker image wrapping `WorkersDalAdapter` | If moving from Workers to Railway/Fly.io/self-hosted |

**No container needed for production API.** Workers handles that natively.

---

## Why NOT alternatives

| Alternative | Why not now |
|---|---|
| Supabase all-in-one | $25/mo min; Clerk is better for multi-tenant org management; migrate later via adapter swap |
| Vercel + PlanetScale | Not on Vercel; PlanetScale deprecated serverless driver |
| Railway + Postgres | $5/mo min; Docker adds ops overhead not needed at 4 customers |
| Firebase / Firestore | Doesn't match relational schema; higher vendor lock-in |
| AWS Lambda + RDS | Vastly exceeds 4-customer requirement |
| Self-hosted | Slowest path to customer 1 |

---

## Pre-onboarding verification gates

- [ ] `GET /api/v1/health` returns 200
- [ ] Clerk org created for customer 1 workspace
- [ ] `GET /api/v1/session` returns workspace context from valid JWT
- [ ] `GET /api/v1/events?workspace_id=<c1>` returns ONLY customer 1 data (isolation proof)
- [ ] `GET /api/v1/events?workspace_id=<c2>` returns ONLY customer 2 data (isolation proof)
- [ ] Frontend `WorkersDalAdapter` connected — events stream renders live data from Neon
- [ ] `GET/POST /api/v1/packets`, `/evidence`, `/approvals`, `/tool-events`, and `/metric-deltas` are workspace-scoped and reject unsafe actions
- [ ] `/api/v1/mcp/*` returns only signed/scoped task packets and packet-bound evidence/status surfaces
- [ ] Phase 2 RLS migration verified on a Neon branch, including RLS policy presence and same-workspace relationship guards
- [ ] Playwright E2E: login C1 → see only C1 data; login C2 → see only C2 data
- [ ] No secrets in git (`wrangler.toml` contains no tokens or DB URLs)

---

## Related docs in this pack

- [DATABASE_SCHEMA_V1.md](./DATABASE_SCHEMA_V1.md) — schema DDL + migration runbook
- [API_CONTRACT_V1.md](./API_CONTRACT_V1.md) — REST endpoint contracts
- [AUTH_TENANCY_MODEL.md](./AUTH_TENANCY_MODEL.md) — Clerk setup + tenant isolation
- [PRODUCTION_LAUNCH_PLAN.md](./PRODUCTION_LAUNCH_PLAN.md) — 3-week plan for customers 1+2
- [BACKEND_ROLE_DEFINITION.md](./BACKEND_ROLE_DEFINITION.md) — backend AI agent role definition
