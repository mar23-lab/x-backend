# API_CONTRACT_V1 · Cloudflare Workers REST API

**Status:** DRAFT — ready for implementation  
**Date:** 2026-05-26  
**Authority:** BACKEND_ADR_001.md stack decision  
**Applies to:** Cloudflare Workers (`src/workers/`) · WorkersDalAdapter

---

## Design principles

1. **R35.HARNESS-FLOW envelope** — every event written via POST /api/v1/events maps 1:1 to the R35 schema
2. **Tenant isolation via JWT** — every authenticated endpoint extracts `org_id` from Clerk JWT; DB queries are scoped `WHERE workspace_id = $1`
3. **Idempotent writes** — POST /api/v1/events is idempotent on `id` field (upsert semantics)
4. **Visibility enforcement at DB layer** — `operation_events.visibility` is enforced via SQL, never in application code
5. **Backend-agnostic DAL** — all endpoints call `DalAdapter` interface methods; no direct DB calls in route handlers
6. **No client-side pagination token** on Day 1 — offset-based `?limit=50&before=<event_id>` for simplicity; cursor-based in Phase 2
7. **CORS locked** — `Access-Control-Allow-Origin: https://*.xlooop.com` (no wildcard in production)
8. **Safe operational spine** — packets, evidence, approvals, tool events, and metric deltas are tenant-scoped projections; raw graph, full tenant memory, platform templates, routing internals, scoring internals, and secrets are never exposed by these APIs

---

## Base URL

```
https://api.xlooop.com/api/v1
```

Local dev:
```
http://localhost:8787/api/v1
```

---

## Authentication

All endpoints except `/health` require a valid Clerk JWT in the `Authorization: Bearer <token>` header.

The worker validates the JWT against Clerk's JWKS endpoint (cached per `CLERK_JWKS_CACHE_TTL_SECONDS`). On validation:
- `sub` → `user_id`
- `org_id` → `workspace_id` (every DB query scoped to this)
- `org_role` → used for RBAC checks (`admin` → operator, `basic_member` → viewer)

If the JWT is missing or invalid → `401 Unauthorized`.
If `org_id` is missing (personal session, not org session) → `403 Forbidden`.

---

## Error envelope

All errors return a consistent JSON body:

```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "request_id": "CF-Ray-header-value"
}
```

`request_id` matches the `CF-Ray` response header for Cloudflare trace correlation.

### Standard error codes

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Request body or params failed schema validation |
| 401 | `UNAUTHORIZED` | Missing or invalid JWT |
| 403 | `FORBIDDEN` | Authenticated but insufficient role/scope |
| 404 | `NOT_FOUND` | Resource not found (always scoped to workspace) |
| 409 | `CONFLICT` | Duplicate `id` on write (idempotent writes return 200 instead) |
| 422 | `UNPROCESSABLE` | Valid JSON but semantic error (e.g. invalid status transition) |
| 429 | `RATE_LIMITED` | Cloudflare rate limit hit |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 503 | `SERVICE_UNAVAILABLE` | Neon connection timeout or worker cold-start timeout |

---

## Endpoints

### GET /api/v1/health

**Auth:** None required  
**Purpose:** Uptime check for Cloudflare health checks and monitoring

**Response 200:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-05-26T12:00:00Z"
}
```

No DB call. Worker startup check only.

---

### GET /api/v1/session

**Auth:** Required
**Purpose:** Returns the current user's workspace + project context (replaces repeated auth lookups in the UI)

**Response 200:**
```json
{
  "user": {
    "id": "user_abc123",
    "email": "operator@acme.com",
    "role": "operator"
  },
  "workspace": {
    "id": "org_xyz456",
    "name": "Acme Corp",
    "slug": "acme-corp",
    "workspace_type": "company",
    "relationship_status": "customer_active"
  },
  "projects": [
    {
      "id": "proj_001",
      "name": "Q3 Operations Launch",
      "status": "active"
    }
  ]
}
```

**DAL call:** `DalAdapter.getSession(userId, workspaceId)`  
**DB query scope:** `WHERE workspace_id = $1 AND status != 'archived'`

`workspace.workspace_type` (`personal|company|mirror|bootstrap|external`) and
`workspace.relationship_status` (`internal_dogfood|customer_zero|external_evaluation|pilot_candidate|pilot_contracted|customer_active|customer_inactive|commercial_partner|technology_partner|vendor|archived`)
are OPTIONAL — present only once migration 085 (STAGED, operator-applied) adds the typing columns.
Pre-085 the workspace object is exactly `{id, name, slug}`; consumers must not hard-depend on the
typing fields (Q-A, 260720).

---

### GET /api/v1/events

**Auth:** Required
**Purpose:** Returns paginated operation events for the workspace, filtered by visibility per role

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | 50 | Max events to return (max: 200) |
| `before` | string | — | Event `id` for cursor-based pagination (exclusive) |
| `project_id` | string | — | Filter to a specific project |
| `status` | string | — | Filter: `queued\|running\|blocked\|needs_review\|completed\|failed\|approved\|rejected\|archived` |
| `source_tool` | string | — | Filter: `codex\|claude\|harness\|mbp\|xlooop\|operator` |

**Visibility enforcement (at SQL layer, not app layer):**

| Role | Visible visibility values |
|---|---|
| `owner` | `internal_workspace`, `internal_project`, `internal_owner_only`, `public_safe` |
| `operator` | `internal_workspace`, `internal_project`, `public_safe` |
| `viewer` | `internal_project`, `public_safe` |
| `client` | `public_safe` |

**Response 200:**
```json
{
  "events": [
    {
      "id": "evt_abc123",
      "workspace_id": "org_xyz456",
      "project_id": "proj_001",
      "source_tool": "claude",
      "agent_id": "session-abc",
      "intent_id": null,
      "status": "completed",
      "summary": "Refactored auth middleware",
      "body": "Full event detail...",
      "evidence_link": "https://github.com/org/repo/commit/abc123",
      "visibility": "internal_workspace",
      "permission_scope": null,
      "risk": null,
      "approval_state": null,
      "next_action": null,
      "occurred_at": "2026-05-26T11:00:00Z",
      "ingested_at": "2026-05-26T11:00:01Z"
    }
  ],
  "pagination": {
    "has_more": true,
    "next_before": "evt_abc122"
  }
}
```

**DAL call:** `DalAdapter.listEvents(workspaceId, { limit, before, projectId, status, sourceTool, role })`  
**DB query:** includes `AND archived_at IS NULL` (uses partial index `idx_events_active`)

---

### POST /api/v1/events

**Auth:** Required  
**Purpose:** Ingests an operation event (from Codex, Claude, MBP harness, or operator)

**Request body** (maps to `R35.HARNESS-FLOW` envelope):
```json
{
  "id": "evt_abc124",
  "source_tool": "claude",
  "agent_id": "session-bdc51f5b",
  "project_id": "proj_001",
  "intent_id": null,
  "status": "completed",
  "summary": "Deployed auth worker",
  "body": "Full detail of what was done...",
  "evidence_link": "https://github.com/org/repo/actions/run/123",
  "visibility": "internal_workspace",
  "permission_scope": null,
  "risk": null,
  "approval_state": null,
  "next_action": null,
  "occurred_at": "2026-05-26T11:05:00Z"
}
```

**Idempotency:** If `id` already exists in the workspace, returns `200 OK` with the existing event (no update). New events return `201 Created`.

**Validation:**
- `id`: required, string, max 128 chars
- `source_tool`: required, one of `codex|claude|harness|mbp|xlooop|operator`
- `status`: required, one of the 9 status values
- `summary`: required, string, max 512 chars
- `occurred_at`: required, ISO 8601 timestamp
- `visibility`: optional (default: `internal_workspace`)
- All other fields: optional

**Response 201 / 200:**
```json
{
  "id": "evt_abc124",
  "created": true
}
```

**DAL call:** `DalAdapter.upsertEvent(workspaceId, eventData)`

---

### GET /api/v1/projects

**Auth:** Required  
**Purpose:** Returns all projects for the workspace

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `status` | string | `active` | Filter by project status |

**Response 200:**
```json
{
  "projects": [
    {
      "id": "proj_001",
      "workspace_id": "org_xyz456",
      "name": "Q3 Operations Launch",
      "status": "active",
      "description": null,
      "metadata": {},
      "created_at": "2026-05-01T00:00:00Z",
      "updated_at": "2026-05-26T11:00:00Z"
    }
  ]
}
```

**DAL call:** `DalAdapter.listProjects(workspaceId, { status })`

---

### GET /api/v1/board-cards

**Auth:** Required  
**Purpose:** Returns board cards for a project, grouped by lane

**Query params:**

| Param | Type | Required | Description |
|---|---|---|---|
| `project_id` | string | YES | Project to fetch cards for |
| `lane` | string | — | Filter to specific lane |
| `status` | string | — | Filter by card status |

**Response 200:**
```json
{
  "board_cards": [
    {
      "id": "card_abc001",
      "workspace_id": "org_xyz456",
      "project_id": "proj_001",
      "title": "Review auth worker deployment",
      "body": "Operator review required...",
      "status": "review",
      "lane": "in_flight",
      "assignee_id": "user_abc123",
      "event_id": "evt_abc124",
      "evidence_link": null,
      "position": 0,
      "metadata": {},
      "created_at": "2026-05-26T11:05:00Z",
      "updated_at": "2026-05-26T11:05:00Z"
    }
  ]
}
```

**DAL call:** `DalAdapter.listBoardCards(workspaceId, projectId, { lane, status })`  
**DB query:** ordered by `lane, position ASC`

---

### POST /api/v1/sign-offs

**Auth:** Required  
**Purpose:** Records an operator sign-off (approved / rejected / noted) on an event

**Request body:**
```json
{
  "event_id": "evt_abc124",
  "verdict": "approved",
  "comment": "Looks good — shipped cleanly."
}
```

**Validation:**
- `event_id`: required, must exist in the workspace
- `verdict`: required, one of `approved|rejected|noted`
- `comment`: optional, string, max 2000 chars

**Transaction:** In a single DB transaction:
1. Insert into `sign_offs`
2. Update `operation_events.approval_state = verdict` WHERE `id = event_id`

**Response 201:**
```json
{
  "id": 42,
  "event_id": "evt_abc124",
  "user_id": "user_abc123",
  "verdict": "approved",
  "signed_at": "2026-05-26T11:06:00Z"
}
```

**DAL call:** `DalAdapter.createSignOff(workspaceId, userId, signOffData)`

---

### GET /api/v1/packets

**Auth:** Required
**Purpose:** Returns scoped task packets for the current workspace. Packets are the safe execution boundary for agents and MCP tools; they are not raw MB-P graph exports.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | 50 | Max packets to return (max: 200) |
| `status` | string | — | Filter by packet status |
| `project_id` | string | — | Filter to a specific project |
| `packet_id` | string | — | Filter to a specific packet |

**Response 200:**
```json
{
  "packets": [
    {
      "id": "pkt_abc123",
      "workspace_id": "org_xyz456",
      "project_id": "proj_001",
      "event_id": "evt_abc124",
      "title": "Collect launch evidence",
      "summary": "Collect scoped evidence and submit callbacks.",
      "lifecycle_state": "ready",
      "allowed_tools": ["mcp.submit_evidence", "mcp.report_tool_event"],
      "forbidden_tools": ["search_all_memory", "raw_graph_export"],
      "source_refs": ["evt_abc124"],
      "evidence_ref_ids": [],
      "approval_required": true,
      "actor_user_id": "user_abc123",
      "created_at": "2026-06-17T02:00:00Z",
      "updated_at": "2026-06-17T02:00:00Z"
    }
  ]
}
```

**DAL call:** `DalAdapter.listTaskPackets(workspaceId, opts)`

---

### POST /api/v1/packets

**Auth:** Required; role `owner` or `operator`
**Purpose:** Creates a scoped task packet for agent/tool execution. The backend derives `workspace_id` and `created_by` from auth; client-supplied workspace/user values are ignored.

**Request body:**
```json
{
  "project_id": "proj_001",
  "event_id": "evt_abc124",
  "title": "Collect launch evidence",
  "summary": "Collect scoped evidence and submit callbacks.",
  "lifecycle_state": "ready",
  "allowed_tools": ["mcp.submit_evidence", "mcp.report_tool_event"],
  "source_refs": ["evt_abc124"],
  "approval_required": true
}
```

**Response 201:** created packet row.

**Safety rules:**
- `workspace_id` is always taken from the Clerk org claim.
- `allowed_tools` must be explicitly listed when a packet grants execution context.
- `forbidden_tools` defaults include raw graph export, full tenant memory export, internal template export, governance scoring export, private graph schema export, secret access, and search-all-memory.
- Packets carry safe instructions and references only; they do not expose raw graph, platform internals, secrets, or broad memory search.

**DAL call:** `DalAdapter.createTaskPacket(workspaceId, userId, packetData)`

---

### GET /api/v1/evidence

**Auth:** Required
**Purpose:** Lists evidence callbacks for the current workspace.

**Query params:** `limit`, `packet_id`, `event_id`, `kind`

**Response 200:**
```json
{
  "evidence": [
    {
      "id": "evd_abc123",
      "workspace_id": "org_xyz456",
      "packet_id": "pkt_abc123",
      "event_id": null,
      "kind": "metric",
      "title": "Provider L3 evidence",
      "uri": "https://provider.example/report/123",
      "summary": "Provider reported error-health evidence.",
      "redaction_status": "redacted",
      "actor_user_id": "user_abc123",
      "created_at": "2026-06-17T02:05:00Z"
    }
  ]
}
```

**DAL call:** `DalAdapter.listEvidenceItems(workspaceId, opts)`

---

### POST /api/v1/evidence

**Auth:** Required; role `owner` or `operator`
**Purpose:** Submits a governed evidence callback for a packet or event.

**Request body:**
```json
{
  "packet_id": "pkt_abc123",
  "kind": "metric",
  "title": "Provider L3 evidence",
  "uri": "https://provider.example/report/123",
  "summary": "Provider reported error-health evidence.",
  "redaction_status": "redacted"
}
```

**Safety rules:**
- Evidence must reference the same workspace as its packet/event.
- `raw_graph`, `full_tenant_memory`, `secret`, and internal scoring/template evidence kinds are rejected by API validation.
- Attaching evidence to a packet updates packet evidence refs and can move the packet to `evidence_ready`.

**DAL call:** `DalAdapter.createEvidenceItem(workspaceId, userId, evidenceData)`

---

### GET /api/v1/approvals

**Auth:** Required
**Purpose:** Lists approval workflow requests for the current workspace.

**Query params:** `limit`, `packet_id`, `status`

**DAL call:** `DalAdapter.listApprovalRequests(workspaceId, opts)`

---

### POST /api/v1/approvals

**Auth:** Required; role `owner` or `operator`
**Purpose:** Requests approval for a packet/action before external writes or destructive operations.

**Request body:**
```json
{
  "packet_id": "pkt_abc123",
  "reason": "Operator review required before writeback."
}
```

**Response 201:** approval request row with `status: "requested"`.

**Safety rules:**
- Approval rows are workspace scoped.
- Destructive deletion, external writes, and markdown writeback require approval before execution.

**DAL call:** `DalAdapter.createApprovalRequest(workspaceId, userId, approvalData)`

---

### PATCH /api/v1/approvals/:id

**Auth:** Required; role `owner` or `operator`
**Purpose:** Records an approval decision.

**Request body:**
```json
{
  "status": "approved",
  "decision_comment": "Approved for this packet only."
}
```

**Validation:** `status` must be `approved`, `rejected`, or `cancelled`; already-decided requests cannot be decided again.

**DAL call:** `DalAdapter.decideApprovalRequest(workspaceId, approvalId, userId, decisionData)`

---

### GET /api/v1/tool-events

**Auth:** Required
**Purpose:** Lists tool/MCP execution reports for the current workspace.

**Query params:** `limit`, `packet_id`, `tool_name`

**DAL call:** `DalAdapter.listToolEvents(workspaceId, opts)`

---

### POST /api/v1/tool-events

**Auth:** Required; role `owner` or `operator`
**Purpose:** Reports a scoped tool event from Codex, Claude, MCP, or product automation.

**Request body:**
```json
{
  "packet_id": "pkt_abc123",
  "tool_name": "mcp.submit_evidence",
  "action": "submit_evidence",
  "status": "completed",
  "summary": "Submitted provider evidence callback."
}
```

**Safety rules:**
- Allowed actions are intentionally narrow: `get_task_packet`, `get_allowed_scope`, `submit_evidence`, `report_tool_event`, `request_approval`, `get_workflow_status`, and `get_public_policy_summary`.
- `search_all_memory`, raw graph export, secret access, and unapproved writes are rejected.

**DAL call:** `DalAdapter.createToolEvent(workspaceId, userId, toolEventData)`

---

### GET /api/v1/metric-deltas

**Auth:** Required
**Purpose:** Lists measured metric changes produced by packets, events, evidence, or verifiers.

**Query params:** `limit`, `packet_id`, `metric_id`

**DAL call:** `DalAdapter.listMetricDeltas(workspaceId, opts)`

---

### POST /api/v1/metric-deltas

**Auth:** Required; role `owner` or `operator`
**Purpose:** Records a metric delta attached to a packet/event/evidence item.

**Request body:**
```json
{
  "packet_id": "pkt_abc123",
  "metric_id": "external_tenant_leakage",
  "before_value": 1,
  "after_value": 0,
  "evidence_item_id": "evd_abc123"
}
```

**DAL call:** `DalAdapter.createMetricDelta(workspaceId, userId, metricDeltaData)`

---

## Safe MCP Gateway

The `/api/v1/mcp/*` routes are the external execution-client gateway for Codex,
Claude, MCP clients, and product automation. They consume the same backend
operational spine as `/packets`, `/evidence`, `/approvals`, `/tool-events`, and
`/metric-deltas`, but expose a narrower, packet-first contract.

### GET /api/v1/mcp/tools

**Auth:** Required
**Purpose:** Returns the allowlisted tools and forbidden surfaces for external
execution clients.

**Allowed tools:** `xlooop.get_task_packet`, `xlooop.submit_evidence`,
`xlooop.report_tool_event`, `xlooop.request_approval`,
`xlooop.get_workflow_status`.

**Forbidden surfaces:** raw graph, full tenant memory, Xlooop internal
templates, governance scoring, agent routing, private graph schema, secrets,
and broad search-all-memory.

### GET /api/v1/mcp/task-packets/:id

**Auth:** Required
**Purpose:** Returns a signed task-packet envelope for the current workspace.

**Response 200:**
```json
{
  "schema_id": "xlooop.mcp_task_packet_envelope.v1",
  "issued_at": "2026-06-18T01:00:00Z",
  "packet": { "id": "pkt_abc123" },
  "blocked_surfaces": ["raw_graph", "full_tenant_memory", "search_all_memory"],
  "signature": {
    "alg": "HS256",
    "value": "base64url-hmac"
  }
}
```

**Safety rules:**
- Fails closed with `SIGNING_UNCONFIGURED` when
  `OPERATIONAL_SPINE_PACKET_SIGNING_SECRET` is absent.
- Returns `PACKET_EXPIRED` for expired packets.
- Does not return raw graph, tenant memory, internal templates, scoring, agent
  routing, private graph schema, secrets, or search-all-memory handles.

### POST /api/v1/mcp/evidence

**Auth:** Required; role `owner` or `operator`
**Purpose:** Submits packet-bound evidence. `packet_id` is required.

### POST /api/v1/mcp/tool-events

**Auth:** Required; role `owner` or `operator`
**Purpose:** Reports an allowlisted execution event. Unsafe actions such as
`search_all_memory` are rejected before reaching the DAL.

### POST /api/v1/mcp/approval-requests

**Auth:** Required; role `owner` or `operator`
**Purpose:** Requests packet-bound approval before external writes or
destructive operations. `packet_id` and `reason` are required.

### GET /api/v1/mcp/status?packet_id=...

**Auth:** Required
**Purpose:** Returns the packet plus packet-scoped evidence, approvals, tool
events, and metric deltas for the current workspace.

---

## Customer Data Lifecycle

The customer data lifecycle endpoints are backend execution surfaces for
metadata/redacted export receipts and approved delete/archive receipts. They are
workspace-scoped projections only. They never expose raw graph, full tenant
memory, Xlooop internal templates, governance scoring, agent routing, private
graph schema, secrets, or broad search-all-memory.

### POST /api/v1/customer-data/export-requests

**Auth:** Required; role `owner` or `operator`
**Purpose:** Creates an approval request for a customer metadata/redacted export.

**Request body:**
```json
{
  "reason": "Customer requested export",
  "target_packet_id": "pkt_optional"
}
```

**Response 201:** returns `request_kind=export`, `status=approval_requested`,
the created approval, `export_mode=metadata_redacted_only`, and the blocked
surfaces list.

### POST /api/v1/customer-data/delete-requests

**Auth:** Required; role `owner` or `operator`
**Purpose:** Creates an approval request for a scoped customer delete/archive
operation. `target_packet_id` is required so deletion cannot silently apply to a
whole tenant.

### POST /api/v1/customer-data/export-requests/:approval_id/execute

**Auth:** Required; role `owner` or `operator`
**Purpose:** Executes an approved metadata/redacted export receipt through the
operational spine. Requires an approved approval request and emits an
`evidence_items` receipt plus a `tool_events` audit row.

### POST /api/v1/customer-data/delete-requests/:approval_id/execute

**Auth:** Required; role `owner` or `operator`
**Purpose:** Executes an approved scoped delete/archive operation. The backend
archives the target packet, emits a metadata-only evidence receipt, and records a
tool-event audit row. It does not erase the audit trail. Full irreversible
storage erasure is a later retention workflow and must preserve legal/audit
requirements.

---

## WorkersDalAdapter → DalAdapter interface mapping

The `DalAdapter` interface (ADR-V3-002) is the backend-agnostic seam. `WorkersDalAdapter` implements it using Neon + Clerk:

```typescript
interface DalAdapter {
  getSession(userId: string, workspaceId: string): Promise<SessionContext>
  listEvents(workspaceId: string, opts: EventListOpts): Promise<EventPage>
  upsertEvent(workspaceId: string, event: HarnessFlowEvent): Promise<UpsertResult>
  listProjects(workspaceId: string, opts: ProjectListOpts): Promise<Project[]>
  listBoardCards(workspaceId: string, projectId: string, opts: BoardCardListOpts): Promise<BoardCard[]>
  createSignOff(workspaceId: string, userId: string, signOff: SignOffData): Promise<SignOff>
  createTaskPacket(workspaceId: string, userId: string, input: CreateTaskPacketInput): Promise<TaskPacket>
  listTaskPackets(workspaceId: string, opts: TaskPacketListOpts): Promise<TaskPacket[]>
  createEvidenceItem(workspaceId: string, userId: string, input: CreateEvidenceItemInput): Promise<EvidenceItem>
  listEvidenceItems(workspaceId: string, opts: EvidenceItemListOpts): Promise<EvidenceItem[]>
  createApprovalRequest(workspaceId: string, userId: string, input: CreateApprovalRequestInput): Promise<ApprovalRequest>
  decideApprovalRequest(workspaceId: string, id: string, userId: string, input: ApprovalDecisionInput): Promise<ApprovalRequest | null>
  listApprovalRequests(workspaceId: string, opts: ApprovalRequestListOpts): Promise<ApprovalRequest[]>
  createToolEvent(workspaceId: string, userId: string, input: CreateToolEventInput): Promise<ToolEvent>
  listToolEvents(workspaceId: string, opts: ToolEventListOpts): Promise<ToolEvent[]>
  createMetricDelta(workspaceId: string, userId: string, input: CreateMetricDeltaInput): Promise<MetricDelta>
  listMetricDeltas(workspaceId: string, opts: MetricDeltaListOpts): Promise<MetricDelta[]>
  executeCustomerDataLifecycleRequest(workspaceId: string, userId: string, input: CustomerDataLifecycleExecutionInput): Promise<CustomerDataLifecycleExecution>
}
```

`LocalDalAdapter` (current dev implementation) reads from `window.ENRICHED_STREAM` / local JSON files and implements the same interface — UI never references Neon or Clerk directly.

---

## CORS policy

```
Access-Control-Allow-Origin: https://*.xlooop.com
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 86400
```

Local dev: `http://localhost:*` added to allow-list when `ENVIRONMENT=development`.

---

## Rate limiting (Cloudflare)

- **Per-IP:** 100 requests/minute
- **Per-workspace (JWT org_id):** 500 requests/minute
- **POST /api/v1/events per-workspace:** 200 requests/minute (higher ingestion budget)
- Exceeded → `429 Too Many Requests` with `Retry-After` header

---

## Transport phases

| Phase | Transport | When |
|---|---|---|
| Phase 1 (current) | REST polling (30s interval) | Customer 1–4 onboarding |
| Phase 2 | Server-Sent Events (SSE) | When polling latency > 10s p95 |
| Phase 3 | WebSocket | Only if bidirectional signaling required |

Phase 2 endpoint (deferred): `GET /api/v1/events/stream` → SSE stream with `text/event-stream` content type.

---

## Implementation notes

- All timestamps are UTC ISO 8601 (`TIMESTAMPTZ` in Postgres)
- `event_id` format: any string up to 128 chars (consumers use nanoid or UUID; harness uses `evt_` + UUID)
- `workspace_id` = Clerk org ID (format: `org_<clerk_id>`)
- `user_id` = Clerk user ID (format: `user_<clerk_id>`)
- Workers D1 is NOT used — Neon Postgres via `@neondatabase/serverless` HTTP driver (HTTP-compatible with CF Workers)
- No session middleware — JWT validation is stateless per request
- Operational-spine endpoints are Phase 2 backend surfaces. They are safe projections for external/customer use and agent execution; raw graph, full memory, private graph schema, agent routing, scoring templates, and secrets remain server-side/private.

---

## Supplementary route inventory (added 2026-07-06 — contract completeness)

The sections above specify the core operational spine + Safe MCP gateway. The worker additionally
serves the surfaces below (all under `/api/v1`, all JWT-authed unless noted). This inventory closes
the contract at the ROUTE level; per-endpoint field specs follow the same envelope conventions as the
spine (error envelope, `request_id`, tenant scoping via `auth.workspace_id`). Detailed field specs are
follow-up work where a surface becomes externally consumed.

| Route file | Surfaces | Auth class | Purpose |
|---|---|---|---|
| `customer-chat.ts` | POST /customer-chat | tenant JWT | tenant-scoped AI chief-of-staff (Claude→Llama→deterministic ladder) |
| `documents.ts` | POST/GET /documents | tenant JWT | Stage-2 source-intake documents (bytea storage; metadata list is RLS-routed, 046) |
| `sources.ts` | GET/POST /sources/* | tenant JWT | Clerk-OAuth source connectors (github/google/dropbox/microsoft); disconnect is SOFT (044) |
| `workspaces.ts` | GET/POST /workspaces/* | operator/tenant | workspace create/list, activity-summary, doc grounding |
| `members.ts` | GET /members | tenant JWT | real workspace members (membership-gated; non-member → 403) |
| `profile.ts` | GET /me | JWT | user identity + DB account attributes |
| `readiness.ts` | POST /readiness/submit | JWT | in-app first-login readiness onboarding |
| `request-access.ts` | POST (public) | public | access-request funnel (rate-limited) |
| `diagnose.ts` | GET (public) | public | diagnose-user triage |
| `investor.ts` | /investor/* | investor tier | investor portal (NDA accept, deck download, magic-link invites) |
| `admin.ts` | /admin/* | admin role | admin ops incl. access-request provision |
| `mbp-projection.ts` | GET /mbp-projection, /mbp-live-stream, /mbp-operator-spaces; POST /mbp-live-stream/ingest | operator / ingest token | MB-P operator read-models (see PRODUCTION_DEPENDENCIES.md §5) |
| `graph.ts` | /graph/* | operator | data-graph rebuild/drift/lineage/digest |
| `layout.ts` | GET/PUT /layout | JWT | operator layout overlay |
| `pmf.ts` | /pmf/* | JWT | Sean-Ellis PMF survey |
| `synthetic-domains.ts` | /synthetic-domain*/* | operator/tenant | domain lenses, roadmaps (+ POST /synthetic-domain-roadmap-items/:id/restore, 044) |
| `template-policy-registry.ts` | /template-policy/*, /whoami | tenant JWT | customer-safe template/policy projection |
| `github-webhook.ts`, `activity-webhook.ts` | POST (public) | HMAC / ingest token | event ingestion webhooks |
| `developer-access.ts` | GET | JWT | developer API/desktop setup status |
| `customer-workspace-feed.ts` | GET | tenant JWT | customer-safe starter feed |
| `mcp-rpc.ts` | POST /mcp/rpc | service token | native MCP JSON-RPC transport |

Tenant-isolation note: all tenant-scoped reads carry the app-level `WHERE workspace_id` guard, and the
five core customer tables (`operation_events`, `projects`, `documents`, `board_cards`,
`project_source_bindings`) additionally carry DB-level RLS (migrations 043–047) enforced through the
restricted `xlooop_app` role.
