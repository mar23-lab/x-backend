#!/usr/bin/env node
// scripts/build-production-readiness-state.mjs
//
// ADR-XLOOP-OPS-002 Part F · the production-readiness SSOT generator — a deployment-domain clone of the
// ADR-0095 ARCHITECTURE_STATE_INDEX pattern. It is a PROJECTION: it joins facts that already exist
// (wrangler.toml · SECRETS_AND_CONNECTIONS_MANIFEST.yml · the latest deploy receipt) into one read-model
// and writes PRODUCTION_READINESS_STATE.{yml,md}. It COPIES NOTHING (names/paths/parsed-fields only) and
// MUTATES NO fact source. Rebuild = re-run; the SSOT can never drift from the facts because it is derived.
//
// Run:  node scripts/build-production-readiness-state.mjs
// Verify (ci-local): node scripts/verify-production-readiness-state.mjs

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const P = (...a) => path.join(repoRoot, ...a);
const read = (rel) => { try { return fs.readFileSync(P(rel), 'utf8'); } catch { return null; } };

const RECEIPT = 'docs/deployment/evidence/latest-cloudflare-prod-deploy-receipt.json';
// C0.2 (260713, cutover program): the receipt above tracks the PAGES app (app.xlooop.com) while this
// state file's service_wiring names the API WORKER (xlooop-api → api.xlooop.com) — two different deploy
// surfaces with two different receipts. The worker's own receipt (emitted by emit-deploy-receipt.mjs,
// refuses on build/HEAD mismatch) is tracked as a DISTINCT field so the readiness state never again
// reports a frontend deploy as the backend's. (BACKEND_REPOSITORY_CUTOVER_PREFLIGHT.md, hazard #3.)
const API_RECEIPT = 'docs/deployment/evidence/cloudflare-api-deploy-receipt.json';
const MANIFEST = 'docs/deployment/SECRETS_AND_CONNECTIONS_MANIFEST.yml';
const WRANGLER = 'wrangler.toml';
const OUT_YML = 'docs/deployment/PRODUCTION_READINESS_STATE.yml';
const OUT_MD = 'docs/deployment/PRODUCTION_READINESS_STATE.md';

const nowIso = new Date().toISOString();
let sourceCommit = 'unknown';
try { sourceCommit = execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { /* degrade */ }

const drift = [];

// ── service_wiring · projected FROM wrangler.toml (line parse; no new deps) ───
const wt = read(WRANGLER) || '';
const wtVal = (key) => { const m = wt.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"#\\n]+)"?`, 'm')); return m ? m[1].trim() : null; };
const serviceWiring = {
  worker: wtVal('name') || 'unknown',
  route: (wt.match(/pattern\s*=\s*"([^"]+)"/) || [])[1] || null,
  bindings: [/\[ai\]/.test(wt) ? 'AI' : null, /\[\[send_email\]\]/.test(wt) ? 'EMAIL' : null].filter(Boolean),
  flags: {
    DIGEST_SWEEP_ENABLED: wtVal('DIGEST_SWEEP_ENABLED'),
    RECLASSIFY_CRON_ENABLED: wtVal('RECLASSIFY_CRON_ENABLED'),
  },
};
if (!wt) drift.push('wrangler.toml unreadable — service_wiring is empty');

// ── secrets_status · REVERSE-CITE the manifest (names only; never a value) ────
const man = read(MANIFEST) || '';
const manifestIds = Array.from(man.matchAll(/^\s*- id:\s*([A-Za-z0-9_.\-]+)/gm)).map((m) => m[1]);
const requiredSecrets = ['CLERK_SECRET_KEY', 'DATABASE_URL', 'MBP_OWNER_USER_ID', 'ADMIN_USER_IDS'];
const missingFromManifest = requiredSecrets.filter((s) => !manifestIds.includes(s));
if (!man) drift.push('SECRETS_AND_CONNECTIONS_MANIFEST.yml missing — connections inventory absent');
for (const s of missingFromManifest) drift.push(`required secret ${s} not registered in the manifest`);
const secretsStatus = {
  manifest: MANIFEST,
  inventoried_count: manifestIds.length,
  required: requiredSecrets,
  required_present_in_manifest: requiredSecrets.filter((s) => manifestIds.includes(s)),
};

// ── deploy_receipts · parse the latest receipt (path + parsed fields) ─────────
let deploy = { receipt: RECEIPT, present: false };
const rcptRaw = read(RECEIPT);
if (rcptRaw) {
  try {
    const r = JSON.parse(rcptRaw);
    const gen = r.generated_at ? new Date(r.generated_at) : null;
    const ageDays = gen ? Math.round((Date.now() - gen.getTime()) / 86400000) : null;
    deploy = { receipt: RECEIPT, present: true, live_verified: r.live_verified === true, generated_at: r.generated_at || null, source_commit: r.source_commit || null, age_days: ageDays };
    if (r.live_verified !== true) drift.push('latest deploy receipt is NOT live_verified');
    if (ageDays != null && ageDays > 14) drift.push(`latest deploy receipt is ${ageDays}d old (> 14d staleness threshold)`);
  } catch { drift.push('deploy receipt present but unparseable'); deploy.present = true; }
} else {
  drift.push('no deploy receipt at evidence/latest-cloudflare-prod-deploy-receipt.json');
}

// ── deploy_receipts · the API WORKER receipt (the backend surface; C0.2) ──────
let apiDeploy = { receipt: API_RECEIPT, present: false };
const apiRaw = read(API_RECEIPT);
if (apiRaw) {
  try {
    const r = JSON.parse(apiRaw);
    // built_at is compact UTC (yyyymmddThhmmssZ) — expand to ISO for age math.
    const iso = typeof r.built_at === 'string'
      ? r.built_at.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
      : null;
    const built = iso ? new Date(iso) : null;
    const apiAgeDays = built && !Number.isNaN(built.getTime()) ? Math.round((Date.now() - built.getTime()) / 86400000) : null;
    const healthVerified = !!(r.health_readback && r.build_sha && r.health_readback.build === r.build_sha);
    apiDeploy = {
      receipt: API_RECEIPT,
      present: true,
      surface: r.surface || 'api.xlooop.com (Cloudflare Worker: xlooop-api)',
      build_sha: r.build_sha || null,
      built_at: r.built_at || null,
      health_verified: healthVerified,
      age_days: apiAgeDays,
    };
    if (!healthVerified) drift.push('api-worker deploy receipt lacks a matching health readback (build != build_sha)');
    if (apiAgeDays != null && apiAgeDays > 14) drift.push(`api-worker deploy receipt is ${apiAgeDays}d old (> 14d staleness threshold)`);
  } catch { drift.push('api-worker deploy receipt present but unparseable'); apiDeploy.present = true; }
} else {
  drift.push('no api-worker deploy receipt at evidence/cloudflare-api-deploy-receipt.json');
}

// ── verdict ───────────────────────────────────────────────────────────────────
const verdict = drift.length === 0 ? 'go' : (drift.some((d) => /missing|absent|unreadable|not registered/.test(d)) ? 'no_go' : 'operator_gated');

const state = {
  schema_id: 'xlooop.production_readiness_state.v1',
  generated_at: nowIso,
  generator: 'scripts/build-production-readiness-state.mjs',
  source_commit: sourceCommit,
  verdict,
  sections: {
    service_wiring: serviceWiring,
    secrets_status: secretsStatus,
    deploy_receipts: { api_worker: apiDeploy, prod: deploy },
    data_room_readiness: { note: 'see x-biz/data-room reconciliation (verify-data-room-coherence, ADR-OPS-002 Part G)' },
    gate_status: { note: 'run `node scripts/verify-production-readiness-state.mjs`' },
  },
  drift_flags: drift,
};

// ── emit YAML (hand-serialised; deterministic; no new deps) ───────────────────
const y = [];
const q = (v) => (v === null || v === undefined) ? 'null' : (typeof v === 'boolean' || typeof v === 'number') ? String(v) : `"${String(v).replace(/"/g, '\\"')}"`;
y.push(`schema_id: ${q(state.schema_id)}`);
y.push(`# DO NOT HAND-EDIT — generated by ${state.generator}; source SSOTs: ${WRANGLER}, ${MANIFEST}, ${RECEIPT}`);
y.push(`generated_at: ${q(state.generated_at)}`);
y.push(`source_commit: ${q(state.source_commit)}`);
y.push(`verdict: ${q(state.verdict)}`);
y.push('sections:');
y.push('  service_wiring:');
y.push(`    worker: ${q(serviceWiring.worker)}`);
y.push(`    route: ${q(serviceWiring.route)}`);
y.push(`    bindings: [${serviceWiring.bindings.map(q).join(', ')}]`);
y.push('    flags:');
for (const [k, v] of Object.entries(serviceWiring.flags)) y.push(`      ${k}: ${q(v)}`);
y.push('  secrets_status:');
y.push(`    manifest: ${q(secretsStatus.manifest)}`);
y.push(`    inventoried_count: ${secretsStatus.inventoried_count}`);
y.push(`    required: [${secretsStatus.required.map(q).join(', ')}]`);
y.push(`    required_present_in_manifest: [${secretsStatus.required_present_in_manifest.map(q).join(', ')}]`);
y.push('  deploy_receipts:');
y.push('    api_worker:  # the BACKEND surface (xlooop-api → api.xlooop.com) — C0.2');
for (const [k, v] of Object.entries(apiDeploy)) y.push(`      ${k}: ${q(v)}`);
y.push('    prod:  # the PAGES app (app.xlooop.com) — frontend surface');
for (const [k, v] of Object.entries(deploy)) y.push(`      ${k}: ${q(v)}`);
y.push('  data_room_readiness:');
y.push(`    note: ${q(state.sections.data_room_readiness.note)}`);
y.push('  gate_status:');
y.push(`    note: ${q(state.sections.gate_status.note)}`);
y.push('drift_flags:');
if (drift.length === 0) y.push('  []');
else for (const d of drift) y.push(`  - ${q(d)}`);
fs.writeFileSync(P(OUT_YML), y.join('\n') + '\n');

// ── emit human-readable MD ────────────────────────────────────────────────────
const md = [];
md.push('# Production Readiness State (GENERATED — DO NOT HAND-EDIT)');
md.push('');
md.push(`> Generated by \`${state.generator}\` · source SSOTs: \`${WRANGLER}\`, \`${MANIFEST}\`, \`${RECEIPT}\`.`);
md.push('> This is a derived projection (ADR-OPS-002 Part F, clone of ADR-0095). Re-run to refresh; never edit by hand.');
md.push('');
md.push(`**Verdict:** \`${verdict}\` · **generated:** ${state.generated_at} · **commit:** \`${sourceCommit}\``);
md.push('');
md.push('## Service wiring');
md.push(`- worker \`${serviceWiring.worker}\` → \`${serviceWiring.route}\` · bindings: ${serviceWiring.bindings.join(', ') || 'none'}`);
md.push(`- flags: ${Object.entries(serviceWiring.flags).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
md.push('');
md.push('## Secrets / connections');
md.push(`- inventory: \`${MANIFEST}\` (${secretsStatus.inventoried_count} entries) · required present: ${secretsStatus.required_present_in_manifest.length}/${requiredSecrets.length}`);
md.push('');
md.push('## Latest deploy');
md.push(apiDeploy.present ? `- API worker: ${apiDeploy.receipt} · build \`${apiDeploy.build_sha}\` · health_verified=${apiDeploy.health_verified} · ${apiDeploy.built_at} (${apiDeploy.age_days}d old)` : `- no api-worker deploy receipt`);
md.push(deploy.present ? `- Pages app: ${deploy.receipt} · live_verified=${deploy.live_verified} · ${deploy.generated_at} (${deploy.age_days}d old) · commit \`${deploy.source_commit}\`` : `- no pages deploy receipt`);
md.push('');
md.push('## Drift flags');
md.push(drift.length === 0 ? '- none — state is fresh + coherent' : drift.map((d) => `- ⚠️ ${d}`).join('\n'));
md.push('');
fs.writeFileSync(P(OUT_MD), md.join('\n'));

console.log(`production-readiness-state · verdict=${verdict} · drift_flags=${drift.length} · wrote ${OUT_YML} + ${OUT_MD}`);
