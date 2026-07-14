#!/usr/bin/env node
// scripts/sync-identity-contracts-from-xcp.mjs
// P0.1 (2026-06-04) · DRIFT GATE for the local xcp-identity-contracts mirror.
//
// The Worker DAL vendors a CURATED SUBSET of @xcp/identity-contracts (xcp-platform)
// so Cloudflare Workers builds stay self-contained (no sibling-repo path). This gate
// asserts that the union-type shapes the mirror DOES declare have not silently forked
// from the upstream source-of-truth. It is CHECK-focused (not a blind regenerator) —
// the mirror is a deliberate subset, so refreshes are an explicit auth-semantics review.
//
//   node scripts/sync-identity-contracts-from-xcp.mjs --check   # exit 1 on drift (ci gate)
//   node scripts/sync-identity-contracts-from-xcp.mjs           # print the drift report
//
// Source resolution: XCP_IDENTITY_CONTRACTS_SRC | XCP_PLATFORM_ROOT | default WIP path.
// Authority: identity-contracts mirror-drift finding (architecture review 2026-06-04).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const checkOnly = process.argv.includes('--check');
const mirrorPath = path.join(repoRoot, 'src/workers/dal/types/xcp-identity-contracts.ts');
const sourcePath = resolveSource();
const mirror = fs.readFileSync(mirrorPath, 'utf8');
const source = fs.readFileSync(sourcePath, 'utf8');

// Union types the mirror declares that MUST stay consistent with upstream.
const UNION_TYPES = ['XcpAppId', 'PlatformRole', 'MembershipRole', 'OperatingMode',
  'IdentitySource', 'AssuranceLevel', 'TelemetryScope', 'AppEntitlementStatus'];

const drifts = [];
for (const name of UNION_TYPES) {
  const m = unionMembers(mirror, name);
  if (m === null) continue;                  // not in the curated subset -> skip
  const s = unionMembers(source, name);
  if (s === null) { drifts.push(`${name}: declared in mirror but NOT found upstream`); continue; }
  const mset = new Set(m), sset = new Set(s);
  const fork = m.filter(x => !sset.has(x));  // mirror-only member  -> genuine fork
  const lag = s.filter(x => !mset.has(x));   // upstream-only member -> mirror lag
  if (fork.length) drifts.push(`${name}: FORK mirror-only [${fork.join(', ')}]`);
  if (lag.length) drifts.push(`${name}: LAG upstream-only [${lag.join(', ')}]`);
}
// AppAccessDecision.reason nested union literal.
const mr = reasonValues(mirror), sr = reasonValues(source);
if (mr && sr) {
  const fork = mr.filter(x => !sr.includes(x)), lag = sr.filter(x => !mr.includes(x));
  if (fork.length) drifts.push(`AppAccessDecision.reason: FORK mirror-only [${fork.join(', ')}]`);
  if (lag.length) drifts.push(`AppAccessDecision.reason: LAG upstream-only [${lag.join(', ')}]`);
}

const ver = sourceVersion();
if (drifts.length) {
  console.error(`identity-contracts mirror DRIFT vs @xcp/identity-contracts${ver ? ' v' + ver : ''}:`);
  for (const d of drifts) console.error(`   - ${d}`);
  console.error(`   mirror=${path.relative(repoRoot, mirrorPath)}`);
  console.error(`   source=${sourcePath}`);
  console.error(`   Refresh is a deliberate auth-semantics review — reconcile, then re-run.`);
  process.exit(1);
}
console.log(`identity-contracts mirror check · OK${ver ? ' · v' + ver : ''} · ${UNION_TYPES.length} unions + reason consistent`);
process.exit(0);

function resolveSource() {
  const cands = [
    process.env.XCP_IDENTITY_CONTRACTS_SRC,
    process.env.XCP_PLATFORM_ROOT && path.join(process.env.XCP_PLATFORM_ROOT, 'packages/xcp-identity-contracts/src/index.ts'),
    '/Users/maratbasyrov/WIP/xcp-platform/packages/xcp-identity-contracts/src/index.ts',
    process.env.XCP_PLATFORM_ROOT && path.join(process.env.XCP_PLATFORM_ROOT, 'packages/xcp-identity-contracts/dist/index.d.ts'),
    '/Users/maratbasyrov/WIP/xcp-platform/packages/xcp-identity-contracts/dist/index.d.ts',
  ].filter(Boolean);
  for (const p of cands) if (fs.existsSync(p)) return p;
  console.error('could not find upstream xcp-identity-contracts; set XCP_PLATFORM_ROOT or XCP_IDENTITY_CONTRACTS_SRC');
  process.exit(1);
}
function unionMembers(src, name) {
  const m = src.match(new RegExp(`export type ${name}\\s*=\\s*([\\s\\S]*?);`));
  if (!m) return null;
  return Array.from(m[1].matchAll(/'([^']+)'/g)).map(x => x[1]);
}
function reasonValues(src) {
  const b = src.match(/AppAccessDecision[\s\S]*?reason\s*:\s*([\s\S]*?);/);
  if (!b) return null;
  return Array.from(b[1].matchAll(/'([^']+)'/g)).map(x => x[1]);
}
function sourceVersion() {
  try { return JSON.parse(fs.readFileSync(path.resolve(sourcePath, '../../package.json'), 'utf8')).version; }
  catch { return ''; }
}
