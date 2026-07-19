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

// Parse `wrangler secret list` output. Modern wrangler emits a JSON array of {name,type} — but
// surrounds it with garbage whose PLACEMENT is nondeterministic: an update-check notice precedes it
// on stdout, and the ANSI "[WARNING] Processing wrangler.toml" banner lands on stdout OR stderr
// depending on invocation context (observed live 260720: banner AFTER the JSON on stdout under
// npm/execFileSync — JSON.parse died at the array end; banner on stderr under a plain pipe). The
// banner contains '[' both as ANSI escapes and as the literal "[WARNING]", so a
// slice-from-first-'[' parse fails either way. Robust approach: strip ANSI, then scan each
// candidate '[' with a depth-matched, string-aware extraction; return the first JSON array found.
function parseSecretNames(raw) {
  const cleaned = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  for (let start = cleaned.indexOf('['); start !== -1; start = cleaned.indexOf('[', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            const arr = JSON.parse(cleaned.slice(start, i + 1));
            if (Array.isArray(arr)) {
              return arr.map((e) => (e && typeof e.name === 'string' ? e.name : null)).filter(Boolean);
            }
          } catch {
            // not JSON at this candidate (e.g. the literal "[WARNING]") — try the next '['
          }
          break;
        }
      }
    }
  }
  throw new Error('secret list output contained no parseable JSON array');
}

function selfTest() {
  const cases = [
    { raw: '[{"name":"XLOOOP_RLS_APP_DATABASE_URL","type":"secret_text"},{"name":"CLERK_SECRET_KEY","type":"secret_text"}]', want: true },
    { raw: 'Some wrangler banner\n[{"name":"CLERK_SECRET_KEY","type":"secret_text"}]', want: false },
    { raw: '[]', want: false },
    // live-observed 260720: update notice BEFORE + ANSI [WARNING] banner AFTER the JSON on stdout
    { raw: 'There is a newer version of Wrangler available.\n[{"name":"XLOOOP_RLS_APP_DATABASE_URL","type":"secret_text"}]\n\u001b[33m▲ \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m Processing wrangler.toml configuration\n', want: true },
    // banner (with its literal "[WARNING]") BEFORE the JSON
    { raw: '\u001b[33m▲ [WARNING]\u001b[0m banner first\n[{"name":"XLOOOP_RLS_APP_DATABASE_URL","type":"secret_text"}]', want: true },
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
