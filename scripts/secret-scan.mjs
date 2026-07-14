#!/usr/bin/env node
// T3-C · pre-commit secret scanner (no external dep).
//
// Scans staged files for high-confidence secret patterns. Designed to be
// noisy on real secrets and quiet on demo data. Bypass via
// `git commit --no-verify` and document in docs/learnings.md.
//
// Patterns covered (high signal, low false-positive):
//   - AWS access key id           (AKIA... 16+ alnum)
//   - AWS secret access key       (40-char base64-ish)
//   - GitHub PAT (classic, fine)  (ghp_, gho_, ghu_, ghs_, ghr_)
//   - Slack bot token             (xox[abrps]-...)
//   - Stripe live key             (sk_live_... / rk_live_...)
//   - Anthropic API key           (sk-ant-api03-...)
//   - OpenAI API key              (sk-... 48 alnum)
//   - Google API key              (AIza... 35 alnum)
//   - Generic high-entropy        (only when prefixed with secret/api_key/token=)
//   - Private key blocks          (-----BEGIN ... PRIVATE KEY-----)
//
// Hard skip (these directories never contain real secrets even if they
// match the patterns):
//   - node_modules/  dist/  /audit/
//   - any path containing "test" or "fixture" plus binary files
//
// Run:
//   node scripts/secret-scan.mjs            # scan staged files
//   node scripts/secret-scan.mjs --all      # scan tracked files (CI mode)

import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const SCAN_ALL = args.has('--all');

const PATTERNS = [
  { name: 'AWS access key',     re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS secret key',     re: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/ },
  { name: 'GitHub PAT',         re: /\bgh[opusr]_[A-Za-z0-9]{36,}/ },
  { name: 'Slack bot token',    re: /\bxox[abrps]-[0-9A-Za-z-]{10,}/ },
  { name: 'Stripe live key',    re: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}/ },
  { name: 'Anthropic API key',  re: /\bsk-ant-api03-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key',     re: /\bsk-(?:proj-)?[A-Za-z0-9]{40,}/ },
  { name: 'Google API key',     re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // JWT (leaked session/access token). Anchored on the full 3-segment structure — header (eyJ = base64
  // of `{"`) + payload (eyJ) + signature — so it catches a hardcoded/leaked JWT but NOT a `Bearer ${token}`
  // template literal or a 2-segment fake fixture. (Dedup pick from the everything-claude-code AgentShield
  // scan, 260710: the one class our set missed; tightened from AgentShield's looser `Bearer word.word`.)
  { name: 'JWT token',          re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/ },
  { name: 'Private key block',  re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'High-entropy assign', re: /\b(?:secret|api[_-]?key|token|password)\s*[:=]\s*['"][A-Za-z0-9+\/=_-]{32,}['"]/i },
];

const SKIP_PATH = (p) => (
  /(^|\/)node_modules\//.test(p) ||
  /^v3\/project\/v3\/dist\//.test(p) ||
  /^v3\/project\/v3\/audit\//.test(p) ||
  /\.lock$|\.lockb$|package-lock\.json$/.test(p) ||
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|tar|gz|woff2?|ttf|eot|mp4|mov)$/i.test(p)
);

// Allow-list: known false positives in demo data / docs.
const ALLOW = [
  /demo|fixture|example|seed|placeholder|stub-?signed/i,
  /__V3_BUILD/,
];

function listStaged() {
  const out = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}
function listTracked() {
  const out = execSync('git ls-files', { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

const files = (SCAN_ALL ? listTracked() : listStaged()).filter(p => !SKIP_PATH(p));

let hits = 0;
const found = [];

for (const path of files) {
  let content;
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) continue; // skip >2MB
    content = readFileSync(path, 'utf8');
  } catch (_) { continue; }

  for (const { name, re } of PATTERNS) {
    const m = content.match(re);
    if (!m) continue;
    // line context for allow-list check
    const before = content.slice(0, m.index);
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEnd = content.indexOf('\n', m.index);
    const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (ALLOW.some(a => a.test(line))) continue;
    hits++;
    found.push({ path, pattern: name, line: (before.match(/\n/g) || []).length + 1, snippet: line.trim().slice(0, 120) });
  }
}

if (hits > 0) {
  console.error('✗ secret-scan · found ' + hits + ' potential secret(s):');
  for (const f of found) {
    console.error(`  ${f.path}:${f.line}  ${f.pattern}`);
    console.error(`    > ${f.snippet}`);
  }
  console.error('\nIf these are demo/test data, add a marker (demo|fixture|example|seed|placeholder)');
  console.error('in the same line, or commit with --no-verify and log in docs/learnings.md.');
  process.exit(1);
}

console.log(`✓ secret-scan · ${files.length} file(s) clean`);
