---
name: queue
description: Show the Xlooop work queue — whole-workspace counts and the attention items waiting on a human. Use when the user asks "what needs me", "xlooop queue", "what's waiting", or wants a status view of their governed work.
---

# /xlooop:queue — what needs you right now

1. Call the MCP tool `xlooop.get_current_work` (no arguments). If the server is not connected,
   tell the user to run `claude mcp add --transport http https://api.xlooop.com/api/v1/mcp/rpc --header "Authorization: Bearer $XLOOOP_TOKEN"`
   and mint a token in app.xlooop.com → Settings → Developer access.
2. Render the result as:
   - A one-line headline from `counts`: `N need you · N blocked · N/N done (NN%)`.
   - A table of `attention` rows: Event | Status | Approval | Summary (truncate summaries at ~80 chars) | When.
   - If `attention` is empty and `counts.needs_you` is 0: say "All clear — nothing is waiting on you." and stop.
3. If the tool returns `isError` or a degraded read is suspected (counts all zero but the user expects work),
   say so plainly — never present a failed read as an empty queue.
4. Offer the follow-ups: `/xlooop:packet <id>` to inspect, `/xlooop:open` to review and sign off in the app.

Never claim an item is approved, rejected, or done — approval state comes only from the tool output,
and sign-off itself happens in the app (agent tokens are structurally denied decide-class actions).
