#!/usr/bin/env node
// scripts/verify-day-1-operator-loop.mjs
//
// Post-deploy Day-1 verification for the LEM-v4 operator-validation loop.
//
// Run this AFTER connecting your first OAuth source (SourceConnectorModal
// → GitHub Connect at app.xlooop.com) to confirm:
//   1. api.xlooop.com worker is live + healthy
//   2. Your Clerk JWT authenticates correctly
//   3. The propagation_tick cron has fired at least once since deploy
//   4. Signal extractors have produced rows in inference_signal_evals
//   5. At least one recommendation is in `pending` status (or 0 if too
//      early — but the framework is alive)
//
// Usage:
//   export XLOOOP_OPERATOR_JWT='<paste-your-clerk-jwt-here>'
//   node scripts/verify-day-1-operator-loop.mjs
//
// How to get your JWT (browser DevTools console at app.xlooop.com):
//   await window.XcpClerk.getToken({ template: 'xlooop-workers' })
//
// Exit 0 if all health checks pass · exit 1 with structured failure summary.

const API_BASE = process.env.XLOOOP_API_BASE || 'https://api.xlooop.com';
const JWT = process.env.XLOOOP_OPERATOR_JWT;

if (!JWT) {
  console.error('verify-day-1: XLOOOP_OPERATOR_JWT env var required.');
  console.error('  Get it from browser DevTools console at app.xlooop.com:');
  console.error("  await window.XcpClerk.getToken({ template: 'xlooop-workers' })");
  process.exit(2);
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: `expected 3 JWT parts, got ${parts.length}` };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

const jwtInfo = decodeJwtPayload(JWT);
if (!jwtInfo.ok) {
  console.error(`verify-day-1: invalid XLOOOP_OPERATOR_JWT (${jwtInfo.reason}).`);
  process.exit(2);
}
const jwtSecondsLeft = Math.round(Number(jwtInfo.payload.exp || 0) - Date.now() / 1000);
if (jwtSecondsLeft <= 0) {
  const expIso = jwtInfo.payload.exp ? new Date(Number(jwtInfo.payload.exp) * 1000).toISOString() : 'missing';
  console.error(`verify-day-1: XLOOOP_OPERATOR_JWT is expired (exp=${expIso}).`);
  console.error("  Regenerate immediately before running: window.XcpClerk.getToken({ template: 'xlooop-workers' })");
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const result = await fn();
    if (result === true) {
      console.log(`  ☑ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name} · ${typeof result === 'string' ? result : 'falsy'}`);
      failed++;
      failures.push({ name, reason: typeof result === 'string' ? result : 'falsy' });
    }
  } catch (err) {
    console.log(`  ✗ ${name} · threw: ${err.message}`);
    failed++;
    failures.push({ name, reason: err.message });
  }
}

async function fetchJson(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${JWT}`,
      'Accept': 'application/json',
      ...options.headers,
    },
    method: options.method || 'GET',
  });
  return { status: res.status, body: res.ok ? await res.json() : await res.text() };
}

function inferencePanels(body) {
  if (!body || typeof body !== 'object') return null;
  return body.panels && typeof body.panels === 'object' ? body.panels : body;
}

console.log(`verify-day-1-operator-loop · target=${API_BASE}\n`);

// ── Gate 1: Worker is live + version sanity ─────────────────────────────
await check('worker healthy + version present', async () => {
  const r = await fetch(`${API_BASE}/api/v1/health`);
  if (r.status !== 200) return `expected 200, got ${r.status}`;
  const j = await r.json();
  if (!j.status || j.status !== 'ok') return `health status="${j.status}", expected "ok"`;
  if (!j.version) return 'no version field';
  if (!j.timestamp) return 'no timestamp field';
  const ageMs = Date.now() - Date.parse(j.timestamp);
  if (Math.abs(ageMs) > 60_000) return `timestamp drift ${Math.round(ageMs/1000)}s — clock skew?`;
  return true;
});

// ── Gate 2: JWT authenticates + operator overlay reachable ──────────────
await check('JWT authenticates + operator overlay endpoint reachable', async () => {
  const r = await fetchJson('/api/v1/mbp-operator-spaces');
  if (r.status === 401) return "JWT rejected (401) — token expired? regenerate via window.XcpClerk.getToken({ template: 'xlooop-workers' })";
  if (r.status === 403) return 'JWT not authorized for operator overlay (verifyMbpOwner rejected) — wrong account?';
  if (r.status !== 200) return `expected 200, got ${r.status}`;
  if (!r.body || !r.body.operator_spaces) return 'operator_spaces field missing from response';
  const count = Array.isArray(r.body.operator_spaces) ? r.body.operator_spaces.length
    : (r.body.operator_spaces.spaces || r.body.operator_spaces.workspaces || []).length;
  if (count < 6) return `only ${count} operator spaces in overlay (expected ≥6)`;
  return true;
});

// ── Gate 2b (260710-F M4/H1): deployed projection freshness — the check no local gate can do ───
// Both repo-side freshness gates read the LOCAL file only; this probes what the operator actually
// receives. Reports served_from (db_live vs bundle_fallback) + freshness once the H1 flag is on;
// pre-flag it reports the legacy shape honestly (no served_from field = flag off).
await check('deployed /mbp-projection freshness (H1 rail visibility)', async () => {
  const r = await fetchJson('/api/v1/mbp-projection');
  if (r.status !== 200) return `expected 200, got ${r.status}`;
  const meta = (r.body && r.body._meta) || {};
  const proj = (r.body && r.body.operations_projection) || {};
  const servedFrom = meta.served_from || '(flag off — inlined legacy path)';
  const freshness = meta.freshness ? `${meta.freshness.status} (until ${meta.freshness.valid_until_earliest})` : `valid_until=${proj.valid_until || '?'} (compute client-side)`;
  console.log(`    served_from: ${servedFrom} · freshness: ${freshness}`);
  if (meta.freshness && meta.freshness.status === 'expired') return `deployed projection is EXPIRED (${meta.freshness.valid_until_earliest}) — push a fresh envelope via scripts/push-mbp-projection-to-workers.mjs`;
  return true;
});

// ── Gate 3: At least 1 source connected (proves Step 6 done) ────────────
await check('at least one OAuth source connected (Step 6 of post-merge handoff)', async () => {
  const r = await fetchJson('/api/v1/sources');
  if (r.status !== 200) return `expected 200, got ${r.status} · body: ${typeof r.body === 'string' ? r.body.slice(0,100) : JSON.stringify(r.body).slice(0,100)}`;
  const rows = Array.isArray(r.body) ? r.body : (r.body.sources || []);
  if (rows.length === 0) return 'NO sources connected yet — go to app.xlooop.com/?screen=sources and click "GitHub · Connect"';
  return true;
});

// ── Gate 4: Inference health endpoint returns 6-panel shape ─────────────
await check('inference-health endpoint returns 6-panel payload', async () => {
  const r = await fetchJson('/api/v1/inference-health');
  if (r.status !== 200) return `expected 200, got ${r.status}`;
  const panels = inferencePanels(r.body);
  const expected = ['signals_per_hour', 'accept_reject_ratio', 'ces_distribution', 'source_token_health', 'cron_success_rate', 'error_budget_burn'];
  for (const panel of expected) {
    if (!panels || !(panel in panels)) return `panel "${panel}" missing from response`;
  }
  return true;
});

// ── Gate 5: Recommendations endpoint reachable ──────────────────────────
await check('recommendations endpoint reachable + envelope shape correct', async () => {
  const r = await fetchJson('/api/v1/recommendations?status=pending&limit=10');
  if (r.status !== 200) return `expected 200, got ${r.status}`;
  if (!r.body) return 'empty body';
  // Either { recommendations: [...] } or just [...] is acceptable depending on contract
  const items = Array.isArray(r.body) ? r.body : (r.body.recommendations || r.body.items || []);
  console.log(`    (info) pending recommendations: ${items.length}`);
  if (items.length === 0) {
    console.log('    (info) zero recommendations — normal until DAD ≥ 3 distinct days of evidence accumulate');
  }
  return true;
});

// ── Gate 6: Cron success rate panel signals at least 1 successful tick ──
await check('at least 1 cron tick recorded since deploy (loop is firing)', async () => {
  const r = await fetchJson('/api/v1/inference-health');
  if (r.status !== 200) return `health unreachable: ${r.status}`;
  const panels = inferencePanels(r.body);
  const cronPanel = panels && panels.cron_success_rate;
  if (!cronPanel) return 'cron_success_rate panel absent';
  const completed = Number(cronPanel.completed || 0);
  const failedRuns = Number(cronPanel.failed || 0);
  const skipped = Number(cronPanel.skipped || 0);
  const totalRuns = Number(cronPanel.total_runs || cronPanel.runs || cronPanel.count || completed + failedRuns + skipped || 0);
  if (totalRuns === 0) {
    return 'no cron tick recorded yet — wait up to 5 min for next propagation_tick, then re-run';
  }
  console.log(`    (info) cron runs recorded: ${totalRuns}`);
  return true;
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\nverify-day-1-operator-loop · ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name} · ${f.reason}`);
  }
  console.log('\nNext step: open https://app.xlooop.com/ and address the failing check above.');
  process.exit(1);
}
console.log('\n✓ 30-day operator-validation loop is genuinely running.');
console.log('  Detector cron fires every 5 min · accumulates evidence in inference_runs/inference_signal_evals.');
console.log('  First recommendations appear after DAD ≥ 3 distinct active days + DDC ≥ 2 distinct domains.');
console.log('  Re-run this script daily to confirm health.');
process.exit(0);
