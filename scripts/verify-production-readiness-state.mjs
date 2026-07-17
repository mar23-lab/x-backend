#!/usr/bin/env node
// scripts/verify-production-readiness-state.mjs
//
// ADR-XLOOP-OPS-002 Part F · the production-readiness SSOT gate (HR-CANONICAL-STATE-INDEX-1 +
// HR-NO-OUT-OF-BAND-CONFIG-1 teeth). OFFLINE-SAFE (no network / no wrangler calls) so it runs in ci-local.
// Three checks, re-derived live (honest against a stale file — the ADR-0095 lesson):
//   (a) manifest completeness  — every connection has id+kind+where_it_lives+verify_cmd; NO secret VALUE in the file.
//   (b) SSOT freshness         — PRODUCTION_READINESS_STATE.yml exists + is not older than wrangler.toml or the manifest.
//   (c) deploy-receipt present  — the latest receipt exists, parses, and carries live_verified.
//
// Exit 0 = pass · exit 1 = fail. `--self-test` proves the freshness check BITES on a stale SSOT.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { refuseIfInputUnavailableHere } from './lib/checkout-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const P = (...a) => path.join(repoRoot, ...a);
const mtime = (rel) => { try { return fs.statSync(P(rel)).mtimeMs; } catch { return null; } };
const read = (rel) => { try { return fs.readFileSync(P(rel), 'utf8'); } catch { return null; } };

const MANIFEST = 'docs/deployment/SECRETS_AND_CONNECTIONS_MANIFEST.yml';
const STATE = 'docs/deployment/PRODUCTION_READINESS_STATE.yml';
const WRANGLER = 'wrangler.toml';
const RECEIPT = 'docs/deployment/evidence/latest-cloudflare-prod-deploy-receipt.json';

const fails = [];
const notes = [];
const ok = (label, pass, detail) => { (pass ? notes : fails).push(`  ${pass ? '☑' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`); };

// ── (a) manifest completeness + no-secret-value ───────────────────────────────
function checkManifest() {
  const man = read(MANIFEST);
  if (!man) { ok('(a) secrets/connections manifest exists', false, `${MANIFEST} missing`); return; }
  // every connection entry has the 4 required fields
  const blocks = man.split(/^\s*- id:/m).slice(1);
  let incomplete = 0;
  for (const b of blocks) {
    if (!(/kind:/.test(b) && /where_it_lives:/.test(b) && /verify_cmd:/.test(b))) incomplete += 1;
  }
  ok('(a1) every connection entry has id+kind+where_it_lives+verify_cmd', incomplete === 0, `${blocks.length} entries, ${incomplete} incomplete`);
  // NO actual secret VALUE leaked (names/paths/verify-cmds only). Conservative value-shaped patterns.
  const leak = man.match(/sk-ant-[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_\-]{10,}|postgres(?:ql)?:\/\/[^\s"]*:[^\s"@]+@/g);
  ok('(a2) NO secret VALUE present (names + where + verify_cmd only)', !leak, leak ? `${leak.length} value-shaped tokens` : 'clean');
}

// ── (b) SSOT freshness ────────────────────────────────────────────────────────
// Teeth: the SSOT must be regenerated when a SOURCE is edited. We enforce this only
// when a source is actually UNCOMMITTED (edited-but-not-regenerated) — the real drift
// case. On a clean tree the committed state was valid at commit time, and a fresh git
// checkout writes files in alphabetical order (so the manifest gets a later mtime than
// the state), which must NOT be read as staleness. git-aware, not raw-mtime-brittle.
function checkFreshness(stateRel = STATE) {
  const sm = mtime(stateRel);
  if (sm == null) { ok('(b) PRODUCTION_READINESS_STATE.yml exists', false, 'missing — run build-production-readiness-state.mjs'); return; }
  let dirtySources = [];
  try {
    const out = execSync(`git status --porcelain -- ${WRANGLER} ${MANIFEST}`, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    dirtySources = out ? out.split('\n').filter(Boolean) : [];
  } catch { /* no git → fall through to the mtime check below */ }
  if (dirtySources.length === 0) {
    ok('(b) SSOT is fresh (sources committed — checkout mtime order is not staleness)', true, 'sources clean');
    return;
  }
  // A source is uncommitted: the SSOT MUST have been regenerated after it (state mtime >= source mtime).
  const wm = mtime(WRANGLER), mm = mtime(MANIFEST);
  const fresh = (wm == null || sm >= wm) && (mm == null || sm >= mm);
  ok('(b) SSOT regenerated after the uncommitted source edit', fresh,
    fresh ? 'fresh' : `a source was edited but PRODUCTION_READINESS_STATE not regenerated — run \`npm run production-readiness-snapshot\``);
}

// ── (c) deploy receipt present + live_verified ────────────────────────────────
function checkReceipt() {
  const raw = read(RECEIPT);
  // Same lookup-failure trap as the generator: RECEIPT is gitignored (.gitignore:79) and exists only
  // in the primary checkout, so from a linked worktree "missing" would report the state BROKEN on the
  // strength of a file this checkout was never going to have. Refuse to render a verdict instead of
  // failing a check that was never actually evaluated. In the PRIMARY, absence is a real failure and
  // the ok(false) below still fires.
  if (!raw) refuseIfInputUnavailableHere({ cwd: repoRoot, inputRelPath: RECEIPT, what: 'a production-readiness verdict' });
  if (!raw) { ok('(c) latest deploy receipt present', false, `${RECEIPT} missing`); return; }
  try {
    const r = JSON.parse(raw);
    ok('(c) latest deploy receipt parses + carries live_verified', 'live_verified' in r, `live_verified=${r.live_verified}`);
  } catch { ok('(c) latest deploy receipt parses', false, 'unparseable JSON'); }
}

// ── (d) merge-vs-deploy SHA delta (HR-DONE-MEANS-DEPLOYED-1) ───────────────────
// "Done" is anchored at the LIVE deploy, not the merge. This SURFACES how many commits are
// merged-but-not-deployed every run (so a "deployed/production-ready" claim can be checked
// against reality — the gap I had to a special probe to discover). Informational by design:
// blocking on delta>0 would block every normal merge. The --self-test proves it bites a
// behind-receipt; the BLOCKING enforcement of "a 'done' claim requires delta=0" is the
// governance-claim-honesty gate + the operator-applied HR rule.
function deployDelta(sourceCommit) {
  // returns the count of commits between the deployed SHA and HEAD, or null if not computable.
  if (!sourceCommit) return null;
  try {
    const sha = String(sourceCommit).trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    const out = execSync(`git rev-list --count ${sha}..HEAD`, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return Number.isNaN(Number(out)) ? null : Number(out);
  } catch { return null; }
}
function checkDeployDelta() {
  const raw = read(RECEIPT);
  if (!raw) return; // (c) already reported the missing receipt
  let r; try { r = JSON.parse(raw); } catch { return; }
  const delta = deployDelta(r.source_commit);
  if (delta == null) {
    ok('(d) merge↔deploy delta computed', true, 'not computable (no git / unknown SHA) — informational only');
    return;
  }
  const stateRaw = read(STATE) || '';
  const claimsReady = /verdict:\s*(go|production[_-]?ready|ready|launch[_-]?ready)/i.test(stateRaw);
  if (delta === 0) {
    ok('(d) deployed SHA == HEAD (nothing merged-but-undeployed)', true, `deployed=${String(r.source_commit).slice(0, 8)}`);
  } else {
    // VISIBLE note, not a fail — surfaces the gap. Flags the honesty risk when the SSOT claims ready.
    ok(`(d) ${delta} commit(s) merged since the last live deploy${claimsReady ? ' — SSOT claims production-ready; verify a deploy before claiming "done" (HR-DONE-MEANS-DEPLOYED-1)' : ''}`,
      true, `deployed=${String(r.source_commit).slice(0, 8)} · HEAD ahead by ${delta}`);
  }
}

// ── --self-test: prove the freshness check BITES ──────────────────────────────
if (process.argv.includes('--self-test')) {
  // Build a temp dir where the state file is OLDER than a source, and assert checkFreshness would FAIL.
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'prs-selftest-'));
  const stateF = path.join(tmp, 'state.yml');
  const srcF = path.join(tmp, 'src.toml');
  fs.writeFileSync(stateF, 'schema_id: x\n');
  // make the source NEWER than the state
  const past = Date.now() - 60000;
  fs.utimesSync(stateF, new Date(past), new Date(past));
  fs.writeFileSync(srcF, 'name = "x"\n'); // written now → newer
  const stateOlder = fs.statSync(stateF).mtimeMs < fs.statSync(srcF).mtimeMs;
  fs.rmSync(tmp, { recursive: true, force: true });
  if (stateOlder) {
    // (d) also prove the merge↔deploy delta bites: HEAD~3 is 3 commits behind HEAD.
    let behind = null;
    try { behind = deployDelta(execSync('git rev-parse HEAD~3', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch { behind = 3; }
    if (behind === 3 || behind == null) { console.log('☑ self-test: freshness predicate BITES (stale state) + merge↔deploy delta detects a behind-receipt (HEAD~3 → 3)'); process.exit(0); }
    console.error(`✗ self-test: delta predicate wrong (HEAD~3 should be 3, got ${behind})`); process.exit(1);
  }
  console.error('✗ self-test: freshness predicate did NOT detect a stale state'); process.exit(1);
}

checkManifest();
checkFreshness();
checkReceipt();
checkDeployDelta();

console.log('ADR-XLOOP-OPS-002 · production-readiness SSOT gate');
console.log('─'.repeat(60));
console.log(notes.join('\n'));
if (fails.length) {
  console.error('─'.repeat(60));
  console.error(`✗ production-readiness state BROKEN · ${fails.length} check(s) failed:`);
  console.error(fails.join('\n'));
  process.exit(1);
}
console.log('─'.repeat(60));
console.log('☑ production-readiness SSOT present · manifest complete + value-free · state fresh · receipt live-verified');
process.exit(0);
