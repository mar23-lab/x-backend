#!/usr/bin/env node
// predeploy-migration-gate.mjs · 2026-07-19
//
// WHY THIS EXISTS (the 260719 incident)
//   Prod ran schema-82 CODE against a schema-72 DATABASE for a window, because
//   `wrangler deploy` was run raw with no check that the prod DB was caught up.
//   The migrations had been authored (073→082) but an operator paste used a
//   PLACEHOLDER `DATABASE_URL='…PROD-RW…'`, so every `psql` silently failed to
//   connect — yet the very next command, `wrangler deploy`, succeeded and
//   shipped code that expected tables the DB did not have. Any route touching
//   073→082 objects would 500.
//
//   The check that would have caught it ALREADY EXISTED: scripts/verify-prod-
//   migrations.mjs compares migration files to workers_schema_version and exits
//   2 when the DB is behind. It was simply never BOUND to the deploy path.
//   This gate binds it. It is wired via wrangler.toml `[build].command`, so it
//   runs before EVERY `wrangler deploy` — including a raw one.
//
// BEHAVIOUR (fail-closed where it matters, non-disruptive for dev)
//   * DATABASE_URL unset            -> ADVISORY skip, exit 0 (so `wrangler dev`
//                                       and CI without a DB are not broken).
//   * DATABASE_URL is a placeholder -> ABORT, exit 1 (catches the 260719 paste).
//   * DATABASE_URL set, DB behind   -> ABORT, exit 1 (the core prevention).
//   * DATABASE_URL set, unreachable -> ABORT, exit 1 (a URL you gave MUST work).
//   * DATABASE_URL set, DB current  -> PASS, exit 0.
//
//   Override for a deliberate, operator-approved deploy-ahead-of-DB:
//     DEPLOY_MIGRATION_GATE_BYPASS=1  (audited: it prints a loud banner)

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const url = process.env.DATABASE_URL || '';

function line(s = '') { process.stderr.write(s + '\n'); }
function banner(title) {
  line('');
  line('  ┌─ predeploy-migration-gate ' + '─'.repeat(Math.max(2, 44 - title.length)) + ' ' + title);
}

// 0) explicit, audited bypass
if (process.env.DEPLOY_MIGRATION_GATE_BYPASS === '1') {
  banner('BYPASSED');
  line('  DEPLOY_MIGRATION_GATE_BYPASS=1 — shipping without verifying prod schema.');
  line('  This is only safe if you KNOW the DB is at/ahead of HEAD. Audited.');
  line('');
  process.exit(0);
}

// 1) no DB configured -> advisory skip (dev / CI without a DB)
if (!url) {
  banner('SKIPPED (advisory)');
  line('  DATABASE_URL is unset — cannot verify prod migration state.');
  line('  For a PRODUCTION deploy, set DATABASE_URL to the prod RW string so this');
  line('  gate can confirm the DB is caught up, or run `npm run deploy:prod`.');
  line('');
  process.exit(0);
}

// 2) placeholder detection (the 260719 footgun: DATABASE_URL='…PROD-RW…')
const placeholderRe = /[…<>]|PROD-RW|your[-_ ]|example|changeme|REPLACE|PLACEHOLDER/i;
if (placeholderRe.test(url) || !/^postgres(ql)?:\/\//i.test(url)) {
  banner('ABORT — placeholder DATABASE_URL');
  line('  DATABASE_URL does not look like a real connection string:');
  line('    ' + url.replace(/:[^:@/]+@/, ':****@'));
  line('  This is exactly the 260719 footgun (a placeholder was pasted, psql');
  line('  silently failed, and the deploy shipped anyway). Set the real prod URL.');
  line('');
  process.exit(1);
}

// 3) delegate to the EXISTING verifier (binds the capability, no new check logic),
//    then subtract the audited accepted-pending baseline so the gate blocks only on
//    NEW deploy-ahead drift, not on migrations already known-pending (see the JSON).
banner('verifying prod schema is caught up to HEAD');
const r = spawnSync('node', [resolve(REPO, 'scripts', 'verify-prod-migrations.mjs'), '--json'], {
  cwd: REPO, encoding: 'utf8', env: process.env,
});
// verify-prod-migrations exit codes: 0 ok · 1 no DATABASE_URL/dir · 2 gap · 3 conn/query fail
if (r.status === 3) {
  banner('ABORT — do NOT deploy');
  line('  Could not reach the DB to verify migration state (connection/query failed).');
  line('  A DATABASE_URL you supplied MUST be reachable — fix it, then re-deploy.');
  line('  Deliberate override (audited): DEPLOY_MIGRATION_GATE_BYPASS=1');
  line('');
  process.exit(1);
}
let missing = [];
try { missing = [...new Set((JSON.parse(r.stdout || '{}').missing || []).map((m) => m.version))]; }
catch { line('  (could not parse verifier output; treating as no reported gaps)'); }

// load audited baseline of known-pending migrations
let baseline = new Set();
try {
  const b = JSON.parse(readFileSync(resolve(HERE, 'prod-migration-accepted-pending.json'), 'utf8'));
  baseline = new Set((b.accepted_pending || []).map((e) => e.version));
} catch { /* no baseline -> every missing migration blocks */ }

const unexpected = missing.filter((v) => !baseline.has(v));
const pendingHit = missing.filter((v) => baseline.has(v));

if (unexpected.length === 0) {
  line('  ✓ no unexpected schema drift — deploy may proceed.');
  if (pendingHit.length) {
    line('  (ledger reports ' + pendingHit.length + ' known-pending migration(s) not applied: ' +
         pendingHit.map((v) => String(v).padStart(3, '0')).join(', ') +
         ' — accepted per scripts/prod-migration-accepted-pending.json)');
  }
  line('');
  process.exit(0);
}
banner('ABORT — do NOT deploy (unexpected schema drift)');
line('  The prod DB is missing migration(s) that are NOT in the accepted-pending baseline:');
line('    ' + unexpected.map((v) => String(v).padStart(3, '0')).join(', '));
line('  This is deploy-ahead-of-schema — code that expects these tables will 500.');
line('  Either apply them first:');
line('    for f in src/workers/db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done');
line('  or, if intentionally pending, add them to scripts/prod-migration-accepted-pending.json.');
line('  Deliberate override (audited): DEPLOY_MIGRATION_GATE_BYPASS=1');
line('');
process.exit(1);
