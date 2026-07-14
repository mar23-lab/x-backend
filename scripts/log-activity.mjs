#!/usr/bin/env node
// scripts/log-activity.mjs · R54-Stage3-A
//
// Capture a non-git work event (Claude session, Codex run, operator decision,
// harness milestone) into the cockpit's operation_events via the activity
// producer endpoint (POST /api/v1/webhooks/activity). This is how work that
// isn't a GitHub push reaches the cockpit's "My activity" lane.
//
// Auth: shared-secret bearer token. Set it once:
//   export XLOOOP_INGEST_TOKEN='<the ACTIVITY_INGEST_TOKEN value>'
// (260710-F correction: the webhook verifies the worker secret ACTIVITY_INGEST_TOKEN
//  — activity-webhook.ts — NOT MBP_LIVE_STREAM_INGEST_TOKEN, which guards the
//  live-stream ingest on mbp-projection.ts. The two MAY be bound to the same value
//  in prod, but the contract is ACTIVITY_INGEST_TOKEN; naming the wrong secret here
//  produces silent 401s when the values diverge.)
//
// Usage:
//   node scripts/log-activity.mjs --tool claude --summary "Shipped R54 Stage 3" [opts]
//   node scripts/log-activity.mjs --summary "Reviewed investor deck" --tool operator --status completed
//
// Options:
//   --tool        source_tool: claude|operator|codex|harness|mbp|xlooop  (default: claude)
//   --summary     REQUIRED · 1-512 chars · the headline shown in the cockpit
//   --status      queued|running|blocked|needs_review|completed|failed|approved|rejected  (default: completed)
//   --id          idempotency id (default: activity_<tool>_<epoch>)
//   --body        longer detail (shown in the event detail panel)
//   --occurred-at ISO timestamp (default: now)
//   --evidence    a URL (PR, doc, run log) → the "Open" affordance
//   --project     project_id to attribute to (optional)
//   --workspace   workspace_id (default: server's ACTIVITY_DEFAULT_WORKSPACE)
//   --token       bearer token (default: $XLOOOP_INGEST_TOKEN)
//   --api         API base (default: $XLOOOP_API_BASE_URL or https://api.xlooop.com)
//   --dry-run     print the payload + target, do not POST
//
// Exit 0 on success (event created or idempotently skipped); 1 otherwise.

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const api = String(args.api || process.env.XLOOOP_API_BASE_URL || 'https://api.xlooop.com').replace(/\/$/, '');
const token = String(args.token || process.env.XLOOOP_INGEST_TOKEN || '').trim();
const summary = typeof args.summary === 'string' ? args.summary : '';
const tool = String(args.tool || 'claude');
const status = String(args.status || 'completed');

if (!summary) {
  console.error('✗ --summary is required (1-512 chars)');
  process.exit(1);
}
if (!token && !args['dry-run']) {
  console.error('✗ no token. Set XLOOOP_INGEST_TOKEN (the MBP_LIVE_STREAM_INGEST_TOKEN value) or pass --token.');
  process.exit(1);
}

const epoch = Math.floor(Date.now() / 1000);
const event = {
  id: String(args.id || `activity_${tool}_${epoch}`),
  source_tool: tool,
  status,
  summary,
  occurred_at: typeof args['occurred-at'] === 'string' ? args['occurred-at'] : new Date().toISOString(),
  ...(typeof args.body === 'string' ? { body: args.body } : {}),
  ...(typeof args.evidence === 'string' ? { evidence_link: args.evidence } : {}),
  ...(typeof args.project === 'string' ? { project_id: args.project } : {}),
  ...(typeof args.workspace === 'string' ? { workspace_id: args.workspace } : {}),
};

const url = `${api}/api/v1/webhooks/activity`;
const payload = { events: [event] };

if (args['dry-run']) {
  console.log('DRY RUN — would POST to', url);
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✗ HTTP ${res.status}`, JSON.stringify(json));
    process.exit(1);
  }
  const r = (json.receipts && json.receipts[0]) || {};
  if (r.ok) {
    console.log(`☑ ${r.created ? 'created' : 'already present (idempotent)'} · ${event.id} · ${tool} · "${summary}"`);
    process.exit(0);
  }
  console.error(`✗ rejected · ${event.id} · ${r.reason || 'unknown'}`);
  process.exit(1);
} catch (err) {
  console.error('✗ request failed:', err && err.message ? err.message : String(err));
  process.exit(1);
}
