---
name: report
description: Report work into Xlooop against a task packet — submit evidence, report a tool event, or request an approval. Use when the user says "log this to xlooop", "attach evidence", "record what we did", or "request sign-off". Requires an OPERATOR connector token.
---

# /xlooop:report — the agent reports; humans decide

The write surface is the REST gateway (writes are deliberately not MCP tools yet). All writes need
an **operator** token (`xlk_op_…`) in `$XLOOOP_TOKEN`; a viewer token will 403 by design.

1. Establish the target packet id (ask, or take it from context). The token's packet-prefix fence
   scopes which packets it may touch — a 403 `UGEC_FENCE_VIOLATION` means out-of-scope, not broken.
2. Confirm with the user WHAT will be written before writing (one sentence: action + packet + payload gist).
3. Execute with Bash (idempotency key = a fresh UUID per logical action; reuse it on retry):

   - Evidence: `curl -s -X POST https://api.xlooop.com/api/v1/mcp/evidence -H "Authorization: Bearer $XLOOOP_TOKEN" -H "content-type: application/json" -H "Idempotency-Key: <uuid>" -d '{"packet_id":"…","kind":"link|log|commit|metric|document","reference":"…","note":"…"}'`
   - Tool event: same shape against `/api/v1/mcp/tool-events` with `{"packet_id","tool","action","status"}`.
   - Approval request: `/api/v1/mcp/approval-requests` with `{"packet_id","reason"}`.

4. Read the response and report the SERVER's verdict (id + status), never an optimistic success.
   A 2xx with a receipt id is done; anything else is reported as refused with the server's code.

**Never attempt sign-off, approval decisions, deletion, or member/token management from here** —
agent tokens are structurally denied decide-class actions (`action_denied`). Sign-off happens in the
app: point the user at `/xlooop:open`.
