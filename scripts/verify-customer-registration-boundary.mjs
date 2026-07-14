#!/usr/bin/env node
// verify-customer-registration-boundary.mjs · R56 Stage 4
//
// Static contract guard for the customer-registration funnel boundary:
//   public access-request  →  rate-limit + Turnstile  →  admin approve  →  customer email.
// File-content assertions only (the Codex boundary-verifier pattern); no runtime deps, no network.
// Run: node scripts/verify-customer-registration-boundary.mjs  (exit 0 PASS / 1 FAIL).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];

function read(rel) {
  try {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  } catch {
    return '';
  }
}
function check(cond, id, message) {
  checks.push({ id, ok: !!cond });
  if (!cond) failures.push({ id, message });
}

const requestAccess = read('src/workers/routes/request-access.ts');
const index = read('src/workers/index.ts');
const turnstile = read('src/workers/services/turnstile.ts');
const admin = read('src/workers/routes/admin.ts');
const notifier = read('src/workers/services/email-notifier.ts');
const rateLimit = read('src/workers/middleware/rate-limit.ts');
const sharedHelpers = read('src/workers/dal/shared-helpers.ts');
const wrangler = read('wrangler.toml');

// 1. The public signup POST is rate-limited (Stage 1).
check(
  /app\.use\(\s*['"]\/api\/v1\/request-access['"]/.test(index) && /rateLimit\(/.test(index),
  'rate_limit_mounted_on_request_access',
  'index.ts must mount rateLimit() on /api/v1/request-access'
);
check(
  /RATE_LIMITER_SIGNUP/.test(index),
  'rate_limit_signup_bucket',
  'the signup rate-limit must use the dedicated RATE_LIMITER_SIGNUP bucket'
);

// 2. Turnstile is verified server-side and gated on the secret (Stage 1, wire-now/provision-after).
check(
  /verifyTurnstile\(/.test(requestAccess) && /turnstile_token/.test(requestAccess),
  'turnstile_verified_in_request_access',
  'request-access.ts must read turnstile_token and call verifyTurnstile'
);
check(
  /TURNSTILE_FAILED/.test(requestAccess),
  'turnstile_403_on_failure',
  'request-access.ts must reject a failed Turnstile with code TURNSTILE_FAILED'
);
check(
  /TURNSTILE_SECRET/.test(turnstile) && /skipped:\s*true/.test(turnstile),
  'turnstile_gated_on_secret',
  'turnstile.ts must skip (ok) when TURNSTILE_SECRET is unset (so the funnel works pre-provisioning)'
);
check(
  /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/.test(turnstile),
  'turnstile_siteverify_endpoint',
  'turnstile.ts must verify against the Cloudflare siteverify endpoint'
);

// 3. request-access stays public (no auth middleware on the route itself).
check(
  /public/.test(requestAccess) && !/clerkAuth|requireAuth|requireAdmin/.test(requestAccess),
  'request_access_public',
  'request-access.ts must remain a public endpoint (no clerkAuth/requireAuth/requireAdmin)'
);

// 4. Admin approve fires the customer "you're approved" email (Stage 3.2).
check(
  /notifyCustomerApproved\(/.test(admin),
  'admin_approve_sends_customer_email',
  'admin.ts approve route must call notifyCustomerApproved'
);

// 5. Notifier exposes both notifications via the shared ladder; escapeHtml coerces (prod-500 guard).
check(
  /export async function notifyCustomerApproved/.test(notifier) &&
    /export async function notifyAdminAccessRequest/.test(notifier),
  'notifier_exports',
  'email-notifier.ts must export notifyAdminAccessRequest + notifyCustomerApproved'
);
check(
  /function sendVia\(/.test(notifier),
  'notifier_shared_send_ladder',
  'email-notifier.ts must route both notifications through the shared sendVia() ladder'
);
check(
  /String\(s\s*\?\?\s*''\)/.test(notifier),
  'notifier_escapehtml_coerces',
  'escapeHtml must coerce via String(s ?? "") so a Date created_at never 500s the request'
);

// 6. Rate-limit middleware contract.
check(
  /RATE_LIMIT_EXCEEDED/.test(rateLimit) && /\b429\b/.test(rateLimit),
  'rate_limit_429_contract',
  'rate-limit.ts must return 429 with code RATE_LIMIT_EXCEEDED'
);

// 7. DAL helper consolidation single source of truth (Stage 0).
check(
  /export function makeError/.test(sharedHelpers) && /export function randomNanoid/.test(sharedHelpers),
  'dal_shared_helpers',
  'dal/shared-helpers.ts must export makeError + randomNanoid (single source of truth)'
);

// 8. wrangler documents the provision-after knobs.
check(
  /RATE_LIMITER_SIGNUP/.test(wrangler) && /TURNSTILE_SECRET/.test(wrangler),
  'wrangler_documents_provisioning',
  'wrangler.toml must document the RATE_LIMITER_SIGNUP binding + TURNSTILE_SECRET secret'
);

const status = failures.length === 0 ? 'PASS' : 'FAIL';
const report = {
  schema: 'xlooop.customer_registration_boundary_verifier.v1',
  status,
  checks_total: checks.length,
  checks_passed: checks.filter((c) => c.ok).length,
  failures,
};
console.log(JSON.stringify(report, null, 2));
console.log(
  `verify-customer-registration-boundary · ${status} · ${report.checks_passed}/${report.checks_total} checks`
);
process.exit(failures.length === 0 ? 0 : 1);
