#!/usr/bin/env node
// verify-connector-provider-ssot.mjs · W4/G8 (2026-06-15) · BLOCKING ci-local gate
//
// The connector provider list has TWO declarations: the backend SSOT (src/workers/lib/
// connector-registry.ts, served at GET /api/v1/connectors) and a frontend fallback array
// (SourceConnectorModal.jsx PROVIDERS, used when the fetch is unavailable). They can DRIFT —
// the audit found the frontend list stale relative to the registry. This gate makes the registry
// the single source of truth: every registry provider MUST appear in the frontend list with the
// SAME clerk_slug (the `oauth_<slug>` passed to Clerk). The frontend MAY carry extra "queued"
// placeholders (bitbucket/notion/slack) the registry doesn't yet wire — that's allowed; what's
// forbidden is a registry provider MISSING or MISMATCHED in the frontend (a real drift bug:
// the live registry would offer a provider the fallback can't, or with the wrong OAuth slug).
// `--self-test` proves it catches a missing + a mismatched-slug provider.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'src/workers/lib/connector-registry.ts';
const FRONTEND = 'src/widgets/SourceConnectorModal/SourceConnectorModal.jsx';

// Map provider id -> provider metadata for each declaration. `[^}]*?` keeps the fields
// within one object literal (provider entries have no nested braces), so the pairing is reliable.
function providerMap(src) {
  const map = new Map();
  const re = /\bid:\s*['"]([a-z0-9_]+)['"]([^}]*)}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[2] || '';
    const slug = body.match(/\bclerk_slug:\s*['"]([a-z0-9_]+)['"]/);
    const restricted = body.match(/\brestricted_scope_mode:\s*['"]([a-z0-9_]+)['"]/);
    if (!slug) continue;
    map.set(m[1], {
      clerk_slug: slug[1],
      restricted_scope_mode: restricted ? restricted[1] : null,
    });
  }
  return map;
}

const RESTRICTED_MAILBOX_PROVIDERS = new Set(['gmail', 'outlook']);
const REQUIRED_RESTRICTED_SCOPE_MODE = 'connect_time_only';

function diff(registrySrc, frontendSrc) {
  const reg = providerMap(registrySrc);
  const front = providerMap(frontendSrc);
  const failures = [];
  if (reg.size === 0) failures.push('parsed 0 providers from the registry (parser drift?)');
  for (const [id, descriptor] of reg) {
    if (!front.has(id)) {
      failures.push(`registry provider '${id}' is MISSING from the frontend PROVIDERS fallback (drift — a fetch-failure user could not connect it)`);
    } else if (front.get(id).clerk_slug !== descriptor.clerk_slug) {
      failures.push(`provider '${id}' clerk_slug MISMATCH: registry='${descriptor.clerk_slug}' vs frontend='${front.get(id).clerk_slug}' (wrong OAuth strategy on the fallback path)`);
    }
    if (RESTRICTED_MAILBOX_PROVIDERS.has(id) && descriptor.restricted_scope_mode !== REQUIRED_RESTRICTED_SCOPE_MODE) {
      failures.push(`restricted mailbox provider '${id}' must declare restricted_scope_mode='${REQUIRED_RESTRICTED_SCOPE_MODE}' in the registry (mail scopes must not become blanket sign-in scopes)`);
    }
    if (descriptor.restricted_scope_mode && front.has(id)
      && front.get(id).restricted_scope_mode !== descriptor.restricted_scope_mode) {
      failures.push(`provider '${id}' restricted_scope_mode MISMATCH: registry='${descriptor.restricted_scope_mode}' vs frontend='${front.get(id).restricted_scope_mode || 'absent'}'`);
    }
  }
  return { failures, regSize: reg.size, frontSize: front.size };
}

function main() {
  if (process.argv.includes('--self-test')) {
    const registry = `export const CONNECTOR_REGISTRY = [
      { id: 'github', tier: 'free_active', clerk_slug: 'github' },
      { id: 'google_drive', tier: 'free_active', clerk_slug: 'google' },
      { id: 'gmail', tier: 'free_active', clerk_slug: 'google', restricted_scope_mode: 'connect_time_only' },
    ];`;
    // frontend MISSING google_drive, github with a wrong slug, and gmail missing restricted scope
    // metadata → all must be caught.
    const frontendBad = `const PROVIDERS = [
      { id: 'github', tier: 'free_active', clerk_slug: 'gh_wrong' },
      { id: 'gmail', tier: 'free_active', clerk_slug: 'google' },
      { id: 'slack', tier: 'paid_queued', clerk_slug: 'slack' },
    ];`;
    const frontendGood = `const PROVIDERS = [
      { id: 'github', tier: 'free_active', clerk_slug: 'github' },
      { id: 'google_drive', tier: 'free_active', clerk_slug: 'google' },
      { id: 'gmail', tier: 'free_active', clerk_slug: 'google', restricted_scope_mode: 'connect_time_only' },
      { id: 'slack', tier: 'paid_queued', clerk_slug: 'slack' },
    ];`;
    const bad = diff(registry, frontendBad);
    const good = diff(registry, frontendGood);
    const caughtMissing = bad.failures.some((f) => /MISSING/.test(f));
    const caughtMismatch = bad.failures.some((f) => /MISMATCH/.test(f));
    const caughtRestricted = bad.failures.some((f) => /restricted_scope_mode/.test(f));
    const goodOk = good.failures.length === 0;
    if (caughtMissing && caughtMismatch && caughtRestricted && goodOk) {
      console.log('PASS self-test · catches missing provider, clerk_slug mismatch, and restricted-scope drift; accepts a registry-superset frontend');
      process.exit(0);
    }
    console.error(`FAIL self-test · caughtMissing=${caughtMissing} caughtMismatch=${caughtMismatch} caughtRestricted=${caughtRestricted} goodOk=${goodOk} :: ${JSON.stringify(good.failures)}`);
    process.exit(1);
  }

  let registrySrc, frontendSrc;
  try { registrySrc = readFileSync(join(ROOT, REGISTRY), 'utf8'); }
  catch (e) { console.error('FAIL · cannot read ' + REGISTRY + ': ' + e.message); process.exit(1); }
  try { frontendSrc = readFileSync(join(ROOT, FRONTEND), 'utf8'); }
  catch (e) { console.error('FAIL · cannot read ' + FRONTEND + ': ' + e.message); process.exit(1); }

  const { failures, regSize, frontSize } = diff(registrySrc, frontendSrc);
  if (failures.length) {
    console.error('✗ verify-connector-provider-ssot · ' + failures.length + ' drift issue(s):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`☑ verify-connector-provider-ssot · PASS · all ${regSize} registry providers present in the frontend (${frontSize}) with matching clerk_slug`);
}

main();
