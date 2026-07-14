# @xlooop/mcp-server

**MCP server bridging Claude Code (and any MCP-compatible runtime) to the Xlooop operator app.**

Exposes 7 tools over the Model Context Protocol stdio transport so AI agents working inside a Claude Code session can read state from, and write events into, the operator dashboard at `app.xlooop.com`.

This unblocks the structural gap the R43 wave couldn't close on its own: until the MCP bridge exists, agents working in Claude Code generate state that lives ONLY in chat transcripts; the operator dashboard sees nothing. With this server installed, every governance decision, edit, and proposal flows live into Xlooop in <500ms.

---

## Tools

| Tool | Purpose | Underlying API |
|---|---|---|
| `xlooop.workspace.context` | Get the authenticated session (workspace, role, projects). First call after auth. | `GET /api/v1/session` |
| `xlooop.event.append` | Write an operation event to a workspace/project. The PRIMARY write path. | `POST /api/v1/events` |
| `xlooop.event.list` | Read recent events (paginated, filterable by project/status/actor). | `GET /api/v1/events` |
| `xlooop.project.list` | Enumerate active projects in a workspace. | `GET /api/v1/projects` |
| `xlooop.board.read` | Read the workspace board cards (todo/doing/review/done). | `GET /api/v1/board-cards` |
| `xlooop.signoff.create` | Propose a sign-off; operator approves/rejects in the Xlooop UI. | `POST /api/v1/sign-offs` |
| `xlooop.signoff.await` | Block the calling session until the operator decides (polling, configurable timeout). | `GET /api/v1/sign-offs/:id` (poll) |

Each tool's input schema is exposed via the MCP `ListTools` request and documented at `docs/tool-reference.md`.

---

## Install

### As a local package (development)

```bash
cd packages/xlooop-mcp-server
npm install
npm run build
```

### As a published package

```bash
npm i -g @xlooop/mcp-server
```

(Publishing TBD; track in `docs/handoffs/HANDOFFS_STATUS.md`.)

---

## Authentication

The server reads a bearer token from one of two sources (highest precedence first):

1. **`XLOOOP_TOKEN`** environment variable
2. **`~/.xlooop/credentials.json`** (written by `xlooop login`)

The token is a Clerk session JWT minted for an approved Xlooop user. The Worker (`api.xlooop.com`) validates the signature via Clerk's JWKS and enforces R40 entitlement gating (user must be `status='approved'` with an active workspace_member row).

### Get a token

Until OAuth lands (R44.1), the simplest path:

```bash
xlooop login
```

The CLI walks through:
1. Sign in to `https://app.xlooop.com` in your browser
2. Open DevTools → Console
3. Paste: `await window.XcpClerk.instance.session.getToken({template: 'xlooop-workers'})`
4. Copy the returned JWT
5. Paste into the CLI prompt

The token is saved to `~/.xlooop/credentials.json` with mode `0600`. The CLI then verifies by calling `/api/v1/session` and printing your user + workspace.

---

## Register with Claude Code

After install + login, register the server with Claude Code:

```bash
claude mcp add xlooop "npx -y @xlooop/mcp-server"
```

Or print the config block and paste it manually:

```bash
xlooop register-claude
```

Restart Claude Code. The 7 `xlooop.*` tools will appear in the available-tools list.

---

## CLI subcommands

```
xlooop login              Save a Clerk JWT to ~/.xlooop/credentials.json
xlooop logout             Remove saved credentials
xlooop whoami             Print the authenticated session (calls /api/v1/session)
xlooop ping               Probe api.xlooop.com health (no auth)
xlooop tools              List MCP tool names + descriptions
xlooop register-claude    Print the Claude Code MCP config block
xlooop creds-path         Print the credentials file path
xlooop creds-status       Print whether credentials are loaded (env or file)
xlooop version            Print version
```

---

## Operator-facing examples

### 1. Confirm the bridge works end-to-end

In a Claude Code session, ask:

> "Use the xlooop.workspace.context tool to confirm I'm signed in."

Expected: tool returns `state: "approved_workspace"`, your user info, and your workspace.

### 2. Log a session event into the operator dashboard

> "Use xlooop.event.append to log this session: workspace_id=mbp-private, source_tool=claude-code, status=in-progress, summary='R44 MCP bridge wave starting', actor='claude-session-abc'."

The event appears at `app.xlooop.com` within 2 seconds (next poll). The diagnostic strip's `live-stream` chip bumps from 58 → 59.

### 3. Sign-off blocking flow

> "Use xlooop.signoff.create with workspace_id=mbp-private, reason='proposed XCP-platform tagged release', then xlooop.signoff.await on the returned id with timeout_seconds=600."

Claude blocks. Operator opens Xlooop, clicks Approve. Within 2 seconds, `xlooop.signoff.await` returns `status: 'approved'` and Claude proceeds.

---

## Error envelope

All errors return a stable JSON shape:

```json
{
  "error": "human readable",
  "code": "AUTH_INVALID | AUTH_FORBIDDEN | NOT_FOUND | VALIDATION_ERROR | NETWORK_ERROR | TIMEOUT | WORKER_ERROR | INTERNAL_ERROR",
  "status": 401,
  "request_id": "a02...",
  "hint": "actionable next step"
}
```

Branch on `code`; the message is for humans.

---

## Architecture

```
┌────────────────────────┐         ┌──────────────────────────────┐
│ Claude Code session    │         │ packages/xlooop-mcp-server   │
│ (or any MCP client)    │ stdio   │                              │
│                        │ ───────▶│  Server (MCP SDK)            │
│  user: "log this event"│         │    ↓ dispatch                │
│                        │         │  tools/event-append.ts       │
└────────────────────────┘         │    ↓ api-client              │
                                   └──────────────┬───────────────┘
                                                  │ HTTPS + JWT
                                                  ▼
                                   ┌──────────────────────────────┐
                                   │ api.xlooop.com (Cloudflare   │
                                   │   Worker · Hono routes)      │
                                   │    ↓                         │
                                   │  Neon Postgres               │
                                   │    ↓                         │
                                   │ app.xlooop.com (live view)   │
                                   └──────────────────────────────┘
```

**Single source of truth:** the Xlooop Worker's REST contract (`src/workers/routes/*.ts`). This MCP server is a thin shim. When the contract changes, this package updates types + tool definitions, not data shape.

---

## Roadmap

| Version | Capability | Status |
|---|---|---|
| 0.1.0 (this) | 7 tools · stdio · env+file auth · CLI | shipped |
| 0.2.0 (R44.1) | OAuth-style `xlooop login` via browser callback (no manual JWT paste) | planned |
| 0.3.0 (R44.2) | HTTP transport (for remote MCP clients) | planned |
| 0.4.0 (R48) | Server-sent events push for `xlooop.event.subscribe` | planned |
| 1.0.0 | Production stability + telemetry exfil | planned |

---

## License

MIT. See parent repo `LICENSE`.

---

## Authority + lineage

This package was authored as part of the R44 wave in `mar23-lab/Xlooop-XCP-demo`. See:
- `docs/_archive/audits/260527-r43-sign-in-stabilization/R43_SIGN_IN_STABILIZATION_CLOSEOUT.md` — what came before
- `docs/architecture/AUTH_SURFACES_AUDIT_R42.md` — the auth model this server consumes
- `src/workers/routes/*.ts` — the REST contracts this server wraps
