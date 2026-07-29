#!/usr/bin/env node
// verify-customer-authority-gates.mjs
//
// Customer authority/consent gates over data/customer-onboarding-read-model.json.
//
// PROVENANCE (260730). The composed customer-onboarding gate referenced this path from the
// bootstrap seed 9dc68a7 onward, but the file itself was never ported into x-backend: `git log --
// scripts/verify-customer-authority-gates.mjs` is EMPTY here and a full --all history scan finds
// no blob, so it was never deleted — only the caller was ported. The donor original lives in
// Xlooop-XCP-demo/scripts/verify-customer-authority-gates.mjs.
//
// WHAT WAS DELIBERATELY NOT PORTED. The donor version also asserted 12 UI markers against four
// frontend files:
//   src/widgets/AccountScreens/AccountScreens.jsx
//   src/widgets/AccountScreens/_shared/ProfileScreen.jsx
//   src/widgets/AccountScreens/_shared/account-onboarding.js
//   src/widgets/AccountScreens/_shared/profile-data.js
// x-backend has no src/widgets/ directory at all, and this repo's contract is API-only — frontend
// implementation must not be added here. Those assertions belong with the frontend that owns those
// files, not with the backend, so they are dropped rather than faked. Every remaining assertion
// below is over data/customer-onboarding-read-model.json, which IS owned by this repo.
//
// Exit codes: 0 pass · 1 measured failure · 2 missing/unreadable input (could not measure).
//
//   node scripts/verify-customer-authority-gates.mjs
//   node scripts/verify-customer-authority-gates.mjs --self-test

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const MODEL_REL = 'data/customer-onboarding-read-model.json';

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) process.exit(selfTest());

const modelPath = flagValue(argv, '--model') || path.join(repoRoot, MODEL_REL);
process.exit(main(modelPath));

function main(file) {
  let model;
  try {
    model = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // Distinct from a red: an absent or unparseable read model means this gate did not measure
    // anything, and "could not measure" must never render as "measured clean".
    console.error(`verify-customer-authority-gates · UNMEASURABLE · ${path.relative(repoRoot, file) || file}: ${err.message}`);
    return 2;
  }

  const failures = [];
  const need = (label, ok) => { if (!ok) failures.push(label); };

  // Authority and consent stay pending until the customer explicitly approves.
  need('authority must remain pending until explicit customer approval is recorded', model.authority?.status === 'pending');
  need('consent must remain pending until explicit customer approval is recorded', model.consent?.status === 'pending');
  need('private integrations must be blocked while authority/consent are pending', model.consent?.private_integrations_allowed === false);
  for (const gate of ['authority_confirmed', 'privacy_scope_confirmed', 'source_register_confirmed', 'do_not_ingest_confirmed']) {
    need(`consent.blocked_until missing ${gate}`, Boolean(model.consent?.blocked_until?.includes(gate)));
  }
  for (const gate of ['authority_gate', 'consent_gate', 'source_register_gate', 'invite_milestone']) {
    need(`onboarding gate missing next_action: ${gate}`, Boolean(model.onboarding_gates?.[gate]?.next_action));
  }

  // Access boundary.
  const access = model.access_control || {};
  need('customer-feedback environment must be test.xlooop.com', access.environment === 'test.xlooop.com');
  need('Cloudflare Access must be the environment security boundary', access.security_boundary === 'cloudflare_access_required');
  need('invitation code must be routing only, not auth boundary', access.invitation_code_purpose === 'routing_only_not_auth_boundary');
  need('customer-feedback default mode must be watch/proposal-only', access.default_mode === 'watch_or_proposal_only');
  need('XCP must be second-level entitlement and disabled by default', access.xcp_entitlement === 'second_level_disabled_by_default');
  need('operator mode must be disabled until authority/consent/scope/receipt gates', String(access.operator_mode || '').includes('disabled_until'));

  // Ecosystem backbone and role panel.
  need('customer GitHub remote must not be launched while authority is pending', model.ecosystem_backbone?.github_status === 'not_launched_authority_pending');
  need('customer ecosystem must stay local/dedicated until launch approved', model.ecosystem_backbone?.repo_status === 'local_dedicated_repo_ready');
  need('role panel must include ecosystem-risk-officer', Boolean(model.role_panel?.required?.includes('ecosystem-risk-officer')));
  need('role panel must include commercial-claim-reviewer', Boolean(model.role_panel?.required?.includes('commercial-claim-reviewer')));

  // Private sources stay disconnected.
  const privateSources = model.source_boundaries?.private_sources_not_connected_yet || [];
  for (const source of ['gmail', 'xero', 'drive_dropbox', 'calendar']) {
    need(`private source must remain listed as not connected: ${source}`, privateSources.includes(source));
  }

  // Stop conditions.
  for (const stop of ['private sources', 'GitHub remote', 'commercial traction']) {
    need(`stop condition missing ${stop}`, Boolean(model.stop_conditions?.some((line) => String(line).toLowerCase().includes(stop.toLowerCase()))));
  }

  const status = failures.length ? 'FAIL' : 'PASS';
  console.log(`verify-customer-authority-gates · ${status} · environment=${access.environment || 'missing'} · private_sources_blocked=${privateSources.length}`);
  if (failures.length) {
    console.error(failures.join('\n'));
    return 1;
  }
  return 0;
}

function flagValue(args, flag) {
  const prefix = `${flag}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

// ---- self-test -------------------------------------------------------------
// Each case spawns THIS gate as a child process and observes its real exit code.
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-gates-selftest-'));
  const real = JSON.parse(fs.readFileSync(path.join(repoRoot, MODEL_REL), 'utf8'));

  const control = path.join(dir, 'control.json');
  fs.writeFileSync(control, JSON.stringify(real));

  // Mutant: flip the single most load-bearing invariant — authority silently pre-approved.
  const mutated = JSON.parse(JSON.stringify(real));
  mutated.authority.status = 'approved';
  const mutant = path.join(dir, 'mutant.json');
  fs.writeFileSync(mutant, JSON.stringify(mutated));

  const cases = [
    ['control (real read model) exits 0', control, 0],
    ['mutant (authority.status=approved) exits 1', mutant, 1],
    ['missing input exits 2', path.join(dir, '__absent__.json'), 2],
  ];

  let failed = 0;
  for (const [label, file, want] of cases) {
    const got = spawnSync(process.execPath, [__filename, `--model=${file}`], {
      cwd: repoRoot, stdio: 'pipe', encoding: 'utf8',
    }).status;
    const ok = got === want;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (want ${want}, got ${got})`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`verify-customer-authority-gates:self-test · ${failed ? 'FAIL' : 'PASS'}`);
  return failed ? 1 : 0;
}
