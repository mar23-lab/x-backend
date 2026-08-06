---
name: packet
description: Inspect one Xlooop task packet — its content, workflow status, evidence, approvals and tool events. Use when the user names a packet id, asks "show packet …", or wants the audit picture behind a piece of governed work.
---

# /xlooop:packet <id> — one packet, whole picture

Input: a packet id (argument or from conversation). If none is given, run `xlooop.list_packets`
first and show the recent packets so the user can pick.

1. Call `xlooop.get_task_packet` with `{id}` and `xlooop.get_workflow_status` with `{packet_id}`.
2. Optionally `xlooop.get_evidence` with `{packet_id}` when the user asks for evidence detail.
3. Render:
   - **Header**: packet id, title/intent, status.
   - **Workflow**: evidence count, approvals (state each approval's status — requested/approved/rejected — verbatim from the tool output), tool events count, metric deltas count.
   - **Evidence table** (when fetched): kind | reference | recorded at.
4. Honesty rules: an approval REQUEST is not an approval; render `pending` states plainly. If the
   packet id is refused (403/UGEC fence), explain the token's packet-prefix scope rather than retrying.
5. Follow-ups: `/xlooop:queue` for what needs a human, `/xlooop:open` to act on it in the app.
