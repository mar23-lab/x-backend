---
name: open
description: Open app.xlooop.com in the Claude Code Browser pane — the full-fidelity cockpit for reviewing, approving and signing off governed work. Use when the user wants to see the app, review the queue visually, or perform a sign-off (which agent tokens deliberately cannot do).
---

# /xlooop:open — the full cockpit, without leaving Claude Code

1. Open the app in the Browser pane: `preview_start` with `{url: "https://app.xlooop.com"}` (or
   `navigate` if a pane is already open).
2. **If the pane refuses with "blocked by policy"**: app.xlooop.com is not yet allowed in this
   install's browsing policy. Tell the user to approve the origin when prompted (or ask their org
   admin to allowlist `app.xlooop.com`), then retry. This is a one-time, per-install approval.
3. The pane is a top-level browser tab: the user's Clerk session works first-party, and the app's
   frame-embedding protections (X-Frame-Options) do not apply. Sign-in happens in the pane if needed.
4. Use this for everything decide-class: reviewing evidence in context, approving, rejecting,
   signing off. The agent can read state and report work through MCP tools; **the human decides in
   the app** — that split is the product's governance model, not a limitation.

After the user acts in the pane, re-run `/xlooop:queue` to confirm the server's view moved.
