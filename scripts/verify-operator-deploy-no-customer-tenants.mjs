#!/usr/bin/env node
// scripts/verify-operator-deploy-no-customer-tenants.mjs
//
// R51-ξ-tail (Wave ξ) ci-local gate · operator-deploy boundary guard.
//
// Root incident (2026-05-29): app.xlooop.com was deployed via
// `prepare-cloudflare-pages --env=dev`, which ships the RAW data/spaces.json
// (all workspaces INCLUDING the aps-pty-ltd customer tenant), bypassing the
// Wave-β operator-mbp tenant filter. Result: APS reappeared in the operator's
// MB-P ecosystem cockpit — the exact R50-Tail-7 boundary the project closed.
//
// This gate enforces the deploy-discipline rule:
//   "app.xlooop.com deploys dist-tenant-operator-mbp/ ONLY. The operator
//    bundle MUST contain zero customer-tenant (aps-*) workspaces."
//
// What it checks
// --------------
// 1. operator-mbp manifest declares aps-pty-ltd + aps-access-property-services
//    in excluded_workspaces (intent is recorded).
// 2. A fresh operator-mbp tenant projection contains ZERO aps-* workspace ids
//    in spaces.json + workspace-tree-read-model.json (build-output truth).
// 3. The raw --env=dev Pages bundle (if present at dist-cloudflare/) is NOT
//    silently operator-safe — documents the trap so nobody deploys it to
//    app.xlooop.com by mistake (warns, does not fail, since dist-cloudflare
//    is also the APS/test build dir).
//
// Exit 0 if all hard checks pass; exit 1 otherwise.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Primary APS WORKSPACE ids (this constant is also cross-checked against the operator manifest's
// excluded_workspaces[], so it must stay the workspace-id set, not the broader token set). The broad
// APS-token sweep (incl. aps-business-intake / aps-business / aps-access) lives in
// verify-tenant-bundle-isolation.mjs, which is now wired into deploy-app-prod step [3b] + ci-local.
const CUSTOMER_TENANT_IDS = ['aps-pty-ltd', 'aps-access-property-services'];

let passed = 0;
let failed = 0;
const failures = [];

async function gate(name, fn) {
  try {
    const ok = await fn();
    if (ok === true) {
      console.log(`  ☑ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name} · ${ok}`);
      failed++;
      failures.push({ name, reason: ok });
    }
  } catch (e) {
    console.log(`  ✗ ${name} · threw ${e.message}`);
    failed++;
    failures.push({ name, reason: e.message });
  }
}

console.log('verify-operator-deploy-no-customer-tenants · R51-ξ-tail gate\n');

// ── Gate 1: manifest records the exclusion intent ───────────────────────
await gate('R51-ξ-tail: operator-mbp manifest excludes both APS tenants', async () => {
  const m = JSON.parse(
    await fs.readFile(path.join(REPO, 'data/_tenant-manifests/operator-mbp.json'), 'utf8'),
  );
  const excluded = m.excluded_workspaces || [];
  for (const id of CUSTOMER_TENANT_IDS) {
    if (!excluded.includes(id)) return `operator-mbp manifest does not exclude ${id}`;
  }
  return true;
});

// ── Gate 2: fresh operator projection has ZERO customer tenants ─────────
await gate('R51-ξ-tail: operator-mbp projection contains ZERO aps-* workspaces', async () => {
  const r = spawnSync(
    process.execPath,
    ['scripts/tenant-projection-builder.mjs', '--tenant', 'operator-mbp'],
    { cwd: REPO, encoding: 'utf8' },
  );
  if (r.status !== 0) return `builder failed: ${r.stderr || r.stdout}`;
  const dir = path.join(REPO, 'dist-tenant-operator-mbp', 'data');
  for (const file of ['spaces.json', 'workspace-tree-read-model.json', 'ws-detail.json', 'operations-live-stream.json']) {
    const p = path.join(dir, file);
    if (!existsSync(p)) continue;
    const raw = await fs.readFile(p, 'utf8');
    for (const id of CUSTOMER_TENANT_IDS) {
      // Match the workspace-id as a quoted JSON value (avoids false hits on
      // descriptive prose / excluded_workspaces metadata).
      const re = new RegExp(`"${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
      if (re.test(raw)) return `${file} still contains customer tenant "${id}"`;
    }
  }
  return true;
});

// ── Gate 3: operator projection still has the real operator workspaces ──
await gate('R51-ξ-tail: operator-mbp projection retains the 6 operator workspaces', async () => {
  const spaces = JSON.parse(
    await fs.readFile(path.join(REPO, 'dist-tenant-operator-mbp/data/spaces.json'), 'utf8'),
  );
  const list = Array.isArray(spaces) ? spaces : (spaces.spaces || spaces.workspaces || []);
  const ids = new Set(list.map((w) => w.id));
  for (const required of ['mbp-private', 'xcp-platform', 'xlooop', 'x-biz', 'x-docs', 'x-front']) {
    if (!ids.has(required)) return `operator workspace ${required} missing from projection`;
  }
  return true;
});

// ── Gate 3b (U3): operations-live-stream IS served (not 404 → degraded·stale) ──
await gate('U3: operator-mbp projection includes operations-live-stream.json (freshness source)', async () => {
  const p = path.join(REPO, 'dist-tenant-operator-mbp/data/operations-live-stream.json');
  if (!existsSync(p)) {
    return 'operations-live-stream.json MISSING from projection → app.xlooop.com 404s it → cockpit data-projection-reader defaults to degraded·stale (U3 regression, 2026-06-02)';
  }
  return true;
});

// ── Gate 4: deploy-discipline doc records the rule ──────────────────────
await gate('R51-ξ-tail: operator-deploy runbook documents the dist-tenant-operator-mbp rule', async () => {
  const p = path.join(REPO, 'docs/runbooks/operator-deploy.md');
  if (!existsSync(p)) return 'docs/runbooks/operator-deploy.md missing';
  const src = await fs.readFile(p, 'utf8');
  if (!/dist-tenant-operator-mbp/.test(src)) return 'runbook does not name dist-tenant-operator-mbp';
  if (!/--env=dev/.test(src)) return 'runbook does not warn about the --env=dev trap';
  return true;
});

console.log(`\nverify-operator-deploy-no-customer-tenants · ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name} · ${f.reason}`);
  process.exit(1);
}
process.exit(0);
