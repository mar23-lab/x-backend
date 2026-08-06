# xlooop — operate app.xlooop.com from Claude Code

Governed work, natively in your agent: the queue, packets, evidence and receipts through your own
Xlooop account, with the product's governance intact — **the agent reports work; humans sign off.**

## Install

1. **Mint a connector token** (owner/operator only): app.xlooop.com → Settings → Developer access →
   Mint token. Choose **Read-only** (`xlk_ro_…`) to observe, **Operational** (`xlk_op_…`) to let the
   agent report evidence and request approvals. The token is shown once; it expires in 90 days and
   is scoped to your workspace and packet prefix.
2. **Export it** in the shell that runs Claude Code: `export XLOOOP_TOKEN=xlk_…` (never paste it into chat).
3. **Add the plugin** (or just the MCP server):
   `claude mcp add --transport http xlooop https://api.xlooop.com/api/v1/mcp/rpc --header "Authorization: Bearer $XLOOOP_TOKEN"`
4. Verify: ask Claude to run `xlooop.whoami` — it should name your workspace.

## Commands

| command | what it does |
|---|---|
| `/xlooop:queue` | Whole-workspace counts + the attention queue (what needs a human) |
| `/xlooop:packet <id>` | One packet: content, workflow status, evidence, approvals |
| `/xlooop:report` | Submit evidence / report a tool event / request approval (operator token) |
| `/xlooop:open` | The full cockpit in the Browser pane — review and **sign off** there |

## The governance line (by design, enforced server-side)

- Reads are tenant-scoped to the token's workspace; receipts are redacted; documents are metadata-only.
- An operational token may **report** (packets, evidence, tool events, approval *requests*, metric
  deltas) and may never **decide** — sign-off, approval decisions, deletion and member/token
  management are denied in the token's entitlement itself (`action_denied`). A Claude tool-approval
  click is not an Xlooop sign-off and cannot become one.
- Revoke any token instantly in Settings → Developer access; revocation takes effect on the next request.

## Codex

The same server works in Codex: `codex mcp add xlooop -- --transport http https://api.xlooop.com/api/v1/mcp/rpc --header "Authorization: Bearer $XLOOOP_TOKEN"`
(or add it to `~/.codex/config.toml` per Codex MCP docs). Skills above are Claude Code packaging;
the tool surface is identical.

## Browser-pane note

`/xlooop:open` needs `app.xlooop.com` allowed in your Claude Code browsing policy — a one-time
per-install approval (org admins can allowlist it centrally).
