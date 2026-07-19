#!/usr/bin/env node
// scripts/preflight-rls-dsn.mjs · deploy hard-gate for the RLS application DSN.
//
// WHY (Wave M-B, the top M.3 register risk). Row-level tenant isolation only holds if reads route
// through the NOBYPASSRLS role `xlooop_app`, whose connection string is the secret
// XLOOOP_RLS_APP_DATABASE_URL. It is bound in prod today — but nothing PREVENTS a silent unbinding
// (a fat-fingered `wrangler secret delete`, a dashboard edit, a fresh environment). If it vanishes,
// the app falls back to the owner connection and RLS FAILS OPEN: every tenant read returns every
// tenant's rows, with no error and no test failure. That is the exact "correct green at the wrong
// resolution" the grant-parity gate guards statically — this gate guards it at deploy time.
//
// WHAT. Before `wrangler deploy` runs, list the bound secrets and refuse the deploy unless
// XLOOOP_RLS_APP_DATABASE_URL is present. Fail CLOSED: if the secret list cannot be obtained
// (wrangler not authenticated, network error), we cannot prove the DSN is bound, so we block.
//
// Wired as the head of `deploy:api` (package.json): `node scripts/preflight-rls-dsn.mjs && wrangler deploy ...`.
//
// Use:
//   node scripts/preflight-rls-dsn.mjs             # exit 0 iff the DSN secret is bound
//   node scripts/preflight-rls-dsn.mjs --self-test # offline: exercise the parse/decision logic

import { execFileSync } from 'node:child_process';

const REQUIRED_SECRET = 'XLOOOP_RLS_APP_DATABASE_URL';
const CONFIG = 'wrangler.toml';

// Parse `wrangler secret list` output. Modern wrangler emits a JSON array of {name,type};
// tolerate a leading non-JSON banner line by slicing to the first '['.
function parseSecretNames(raw) {
  const start = raw.indexOf('[');
  if (start === -1) throw new Error('secret list output contained no JSON array');
  const arr = JSON.parse(raw.slice(start));
  if (!Array.isArray(arr)) throw new Error('secret list JSON was not an array');
  return arr.map((e) => (e && typeof e.name === 'string' ? e.name : null)).filter(Boolean);
}

function selfTest() {
  const cases = [
    { raw: '[{"name":"XLOOOP_RLS_APP_DATABASE_URL","type":"secret_text"},{"name":"CLERK_SECRET_KEY","type":"secret_text"}]', want: true },
    { raw: 'Some wrangler banner\n[{"name":"CLERK_SECRET_KEY","type":"secret_text"}]', want: false },
    { raw: '[]', want: false },
  ];
  let ok = true;
  for (const [i, c] of cases.entries()) {
    const got = parseSecretNames(c.raw).includes(REQUIRED_SECRET);
    const pass = got === c.want;
    ok = ok && pass;
    console.log(`  self-test[${i}] ${pass ? 'PASS' : 'FAIL'} — present=${got} expected=${c.want}`);
  }
  console.log(ok ? 'PASS preflight-rls-dsn self-test' : 'FAIL preflight-rls-dsn self-test');
  return ok ? 0 : 1;
}

if (process.argv.includes('--self-test')) {
  process.exit(selfTest());
}

let names;
try {
  const raw = execFileSync('wrangler', ['secret', 'list', '--config', CONFIG], { encoding: 'utf8' });
  names = parseSecretNames(raw);
} catch (err) {
  console.error(`FAIL preflight-rls-dsn: could not list wrangler secrets (${err.message}).`);
  console.error('Refusing the deploy — an unverifiable secret list cannot prove RLS is bound (fail closed).');
  process.exit(1);
}

if (!names.includes(REQUIRED_SECRET)) {
  console.error(`FAIL preflight-rls-dsn: required secret ${REQUIRED_SECRET} is NOT bound.`);
  console.error('Deploying now would fail RLS OPEN (reads fall back to the owner connection → cross-tenant leak).');
  console.error(`Fix: wrangler secret put ${REQUIRED_SECRET} --config ${CONFIG}  (then re-run the deploy).`);
  process.exit(1);
}

console.log(`PASS preflight-rls-dsn: ${REQUIRED_SECRET} is bound (${names.length} secret(s) total) — RLS DSN present.`);
process.exit(0);
