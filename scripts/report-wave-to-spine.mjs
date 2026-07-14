#!/usr/bin/env node
// scripts/report-wave-to-spine.mjs · 260710-F M2 (B2-prep) — GOVERNED dev-agent wave reporting.
//
// The activity webhook (log-activity.mjs) lands the ACTIVITY grain (operation_events, "My activity"
// lane). THIS script lands the GOVERNED grain: a task_packet per wave + tool_events per stage +
// optional evidence — flowing through authorizeSpineWrite + the customer write-sandbox, and (because
// SPINE_TOOL_EVENT_UNIFICATION_ENABLED is LIVE) each tool_event gets a companion operation_events row
// with full 050 actor-lineage for free. This is the dogfooding bridge: dev-agent work rides the SAME
// governance rails customers get.
//
// AUTH (headless): an OPERATOR customer token (`xlk_op_*`) bound to the MB-P workspace, minted ONCE by
// a human owner/operator session via POST /api/v1/developer-access/tokens — available only after the
// operator flips CUSTOMER_API_TOKENS_ENABLED + CUSTOMER_OPERATIONAL_TOKENS_ENABLED (activation train
// step 6c). Until then this script is PREP: --dry-run (the default) prints the exact requests.
//
//   export XLOOOP_OPERATOR_TOKEN='xlk_op_...'
//
// Usage:
//   node scripts/report-wave-to-spine.mjs --wave 260710-F --title "Lineage wave" \
//     --stage "M1:completed:test-sweep repair" --stage "M4:completed:H1 live-rail" \
//     [--evidence-url https://github.com/.../commit/<sha>] [--post]
//
// Options:
//   --wave        REQUIRED · wave id (becomes packet source_refs + tool_event summaries)
//   --title       packet title (default: "Dev-agent wave <wave>")
//   --stage       repeatable · "<name>:<status>:<summary>" (status: completed|failed|running)
//   --evidence-url  optional URL attached as an evidence item (metadata only)
//   --packet-id   reuse an existing packet instead of creating one
//   --api         API base (default: $XLOOOP_API_BASE_URL or https://api.xlooop.com)
//   --post        actually POST (default is DRY-RUN: print requests, send nothing)
//
// Exit 0 on success/dry-run; 1 on any failed POST. Never prints the token.

const args = process.argv.slice(2);
function flagVal(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
function flagAll(name) {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[i + 1]);
  return out;
}
const hasPost = args.includes('--post');
const wave = flagVal('--wave');
if (!wave) { console.error('✗ --wave is required (e.g. --wave 260710-F)'); process.exit(1); }
const title = flagVal('--title') || `Dev-agent wave ${wave}`;
const stages = flagAll('--stage').map((s) => {
  const [name, status = 'completed', ...rest] = s.split(':');
  return { name, status, summary: rest.join(':') || name };
});
if (stages.length === 0) { console.error('✗ at least one --stage "<name>:<status>:<summary>" required'); process.exit(1); }
const evidenceUrl = flagVal('--evidence-url');
const apiBase = flagVal('--api') || process.env.XLOOOP_API_BASE_URL || 'https://api.xlooop.com';
const token = process.env.XLOOOP_OPERATOR_TOKEN || '';
let packetId = flagVal('--packet-id');

const requests = [];
if (!packetId) {
  requests.push({
    label: 'create task_packet',
    method: 'POST', path: '/api/v1/packets',
    body: {
      title, summary: `Dev-agent wave ${wave} — stages: ${stages.map((s) => s.name).join(', ')}`,
      lifecycle_state: 'active',
      allowed_tools: ['dev_wave_report'],
      source_refs: [{ kind: 'dev_wave', ref: wave }],
    },
  });
}
if (evidenceUrl) {
  requests.push({
    label: 'submit evidence',
    method: 'POST', path: '/api/v1/mcp/evidence',
    body: { packet_id: packetId || '<packet id from step 1>', kind: 'link', ref: evidenceUrl, summary: `wave ${wave} evidence` },
  });
}
for (const s of stages) {
  requests.push({
    label: `tool_event · ${s.name}`,
    method: 'POST', path: '/api/v1/mcp/tool-events',
    body: {
      packet_id: packetId || '<packet id from step 1>',
      tool_name: 'dev_wave_report', action: s.name,
      status: s.status === 'failed' ? 'failed' : (s.status === 'running' ? 'running' : 'completed'),
      summary: `[${wave}] ${s.summary}`.slice(0, 512),
    },
  });
}

async function main() {
  if (!hasPost) {
    console.log(`DRY-RUN (pass --post to send) · ${apiBase} · token ${token ? 'present' : 'ABSENT (set XLOOOP_OPERATOR_TOKEN)'}`);
    for (const r of requests) console.log(`\n→ ${r.label}\n  ${r.method} ${r.path}\n  ${JSON.stringify(r.body, null, 2).split('\n').join('\n  ')}`);
    console.log(`\n${requests.length} request(s) prepared. The 057 companion operation_events (actor-lineage) are emitted server-side per tool_event.`);
    return 0;
  }
  if (!token) { console.error('✗ XLOOOP_OPERATOR_TOKEN required for --post'); return 1; }
  for (const r of requests) {
    const res = await fetch(apiBase + r.path, {
      method: r.method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(r.body),
    });
    const text = await res.text();
    if (!res.ok) { console.error(`✗ ${r.label} → ${res.status}: ${text.slice(0, 300)}`); return 1; }
    console.log(`☑ ${r.label} → ${res.status}`);
    if (!packetId && r.path === '/api/v1/packets') {
      try {
        const parsed = JSON.parse(text);
        packetId = parsed?.packet?.id || parsed?.id || null;
        if (packetId) for (const rest of requests) if (rest.body.packet_id === '<packet id from step 1>') rest.body.packet_id = packetId;
      } catch { /* leave placeholder; subsequent posts will 400 loudly */ }
    }
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error('✗', err?.message || err); process.exit(1); });
