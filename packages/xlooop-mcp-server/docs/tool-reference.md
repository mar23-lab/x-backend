# @xlooop/mcp-server · tool reference

Complete API for the 7 MCP tools exposed by this server. All tools require a valid bearer token (see `README.md · Authentication`).

---

## `xlooop.workspace.context`

**First call any MCP client should make.** Confirms the token works + exposes the workspace_id for subsequent calls.

**Input:** none.

**Output:** R40 session response.
```json
{
  "state": "approved_workspace",
  "user": { "id": "user_3EI...", "email": "marat@xlooop.com", "role": "owner" },
  "workspace": { "id": "org_3EIO8Y...", "name": "Xlooop Internal", "slug": "xlooop-internal" },
  "projects": [{ "id": "proj_001", "name": "MB-P governance", "status": "active" }],
  "message": "Active workspace.",
  "operator_bootstrapped": { "workspace_id": "org_3EIO8Y...", "workspace_name": "Xlooop Internal" }
}
```

**Other states:** `authenticated_no_access`, `pending_access`, `access_denied` — branch on `state`.

---

## `xlooop.event.append`

**Primary write path.** Adds an event to a workspace event stream.

**Input:**
- `workspace_id` (required, string)
- `source_tool` (required, string · e.g. `claude-code`, `ci`, `operator`)
- `status` (required, string · e.g. `in-progress`, `completed`, `blocked`)
- `summary` (required, string · short headline for the operator stream)
- `project_id` (optional, string)
- `id` (optional, string · idempotency key)
- `body` (optional, string · markdown body)
- `visibility` (optional, string · default `internal_workspace`)
- `occurred_at` (optional, ISO string)
- `actor` (optional, string · e.g. `claude-session-abc`)
- additional properties allowed for tenant-extension

**Output:** the inserted `OperationEvent` row.

**Idempotency:** if `id` is supplied and matches an existing event, the existing row is returned unchanged.

---

## `xlooop.event.list`

Paginated read of events for a workspace.

**Input:**
- `workspace_id` (required, string)
- `project_id` (optional, string)
- `status` (optional, string)
- `actor` (optional, string)
- `limit` (optional, integer · default 100, max 200)
- `cursor` (optional, string · from prior response's `next_cursor`)

**Output:**
```json
{
  "events": [/* OperationEvent[] */],
  "next_cursor": "opaque-string" | null
}
```

---

## `xlooop.project.list`

Enumerate projects in a workspace.

**Input:**
- `workspace_id` (required, string)
- `include_archived` (optional, boolean · default false)

**Output:**
```json
{
  "projects": [
    { "id": "proj_001", "workspace_id": "org_xxx", "name": "MB-P governance", "status": "active" }
  ]
}
```

---

## `xlooop.board.read`

Read board cards (todo/doing/review/done surface).

**Input:**
- `workspace_id` (required, string)
- `project_id` (optional, string)
- `status` (optional, string · e.g. `todo`, `doing`, `review`, `done`, `blocked`)

**Output:**
```json
{
  "cards": [
    { "id": "card_001", "workspace_id": "org_xxx", "project_id": "proj_001",
      "title": "Review Q3 governance", "status": "review" }
  ]
}
```

---

## `xlooop.signoff.create`

Create a pending sign-off. Operator approves/rejects via the Xlooop app UI.

**Input:**
- `workspace_id` (required, string)
- `reason` (required, string · operator-readable explanation)
- `project_id` (optional, string)
- `event_id` (optional, string · the event being gated)
- `reviewer_user_id` (optional, string · specific reviewer)
- `metadata` (optional, object · free-form payload)

**Output:** the created `SignOff` row with `status: 'pending'`.

**Pair with:** `xlooop.signoff.await` to block until decided.

---

## `xlooop.signoff.await`

Block the caller until a sign-off is decided. Implemented as client-side polling with configurable interval + timeout.

**Input:**
- `sign_off_id` (required, string · from `xlooop.signoff.create`)
- `timeout_seconds` (optional, integer · default 300, range 10–3600)
- `poll_interval_seconds` (optional, integer · default 2, range 1–30)

**Output (on decision):** the `SignOff` row with `status` ∈ `{approved, rejected, cancelled}`.

**Output (on timeout):** `TIMEOUT` error envelope.

**Notes:**
- The sign-off is NOT cancelled on timeout — it stays pending; operator can still approve later via another `await` call.
- Default polling at 2s with Cloudflare Worker + Neon warm latency (~100ms) costs ~10 round-trips before timeout. Real-time push (SSE) is planned for R48.

---

## Error envelope

Every tool can return a structured error:

```json
{
  "error": "human-readable message",
  "code": "AUTH_MISSING | AUTH_INVALID | AUTH_FORBIDDEN | NOT_FOUND | VALIDATION_ERROR | NETWORK_ERROR | TIMEOUT | WORKER_ERROR | INTERNAL_ERROR",
  "status": 401,
  "request_id": "a02...",
  "hint": "actionable next step"
}
```

The MCP SDK marks these as `isError: true` in the response. Branch on `code`, not on the human message.

---

## Underlying REST contract

| Tool | HTTP method | Path |
|---|---|---|
| `xlooop.workspace.context` | GET | `/api/v1/session` |
| `xlooop.event.append` | POST | `/api/v1/events` |
| `xlooop.event.list` | GET | `/api/v1/events` |
| `xlooop.project.list` | GET | `/api/v1/projects` |
| `xlooop.board.read` | GET | `/api/v1/board-cards` |
| `xlooop.signoff.create` | POST | `/api/v1/sign-offs` |
| `xlooop.signoff.await` | GET (poll) | `/api/v1/sign-offs/:id` |

Contract authority: `src/workers/routes/*.ts` in the Xlooop-XCP-demo repo.
