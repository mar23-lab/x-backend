#!/usr/bin/env node
// compare-registry-to-ledger.mjs · R0 (260710-B) · the registry⟷ledger drift reporter that didn't exist.
//
// The 57-row backend-UI contract ledger was HAND-curated (its verifier hard-codes the counts); the Design
// seat's `ui-backend-contracts.json` regenerates from the prototype via their `ui:extract`. Nothing joined
// the two — so a new backend-required control (e.g. the Test-mode feedback widget) could appear in the
// prototype and never reach the ledger. This tool is the mechanical join:
//   registry entry (backendStatus 'backend-required', uiId 'xcp.<domain>.<name>')  ⟷  ledger actions[].ui_id
//   ('<domain>.<name>') — normalization strips the registry's 'xcp.' namespace prefix.
//
// ADVISORY BY DESIGN (exit 0 unless --strict): curation stays human — the tool reports added/removed ids +
// count drift; the BLOCKING verifier (verify-precutover-contract-ledger.mjs) only changes when the ledger
// is deliberately re-curated. Usage:
//   node scripts/compare-registry-to-ledger.mjs [--registry <path>] [--ledger <path>] [--strict]
//
// L4 (260710-D) · FRESHNESS check (WARN-only, even under --strict — freshness is a cross-seat coordination
// fact, not a repo fact; blocking on it would recreate the lease-lapse failure mode): if the ledger's last
// git-commit date is >3 days NEWER than the newest registry-snapshots/<yymmdd> dir, warn that the backend
// contract surface evolved since Design's last export — request a fresh ui:extract. F16 sibling: the drop's
// superseded `ui-backend-contracts.json` (154/282/57) must NEVER be wired here as the default — feeding it
// produces 54 false "missing" drifts (scope artifact, see registry-snapshots/260710/README.md).

import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const strict = process.argv.includes('--strict');
const registryPath = arg('--registry', 'docs/frontend-migration/precutover-hardening/registry-snapshots/260710/UI-REGISTRY-EXPORT-260710.json');
const ledgerPath = arg('--ledger', 'docs/frontend-migration/precutover-hardening/backend-ui-contract-ledger-260709.json');

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));

// 260710-C · accept BOTH registry schemas: ui-backend-contracts.json (camelCase `entries[]` with
// uiId/backendStatus) AND the Design export UI-REGISTRY-EXPORT-*.json (snake_case `rows[]` with
// ui_id/backend_status). Normalize to one shape here — adapter, not fork.
const rawEntries = Array.isArray(registry) ? registry
  : registry.entries ?? registry.rows
  ?? Object.values(registry).find((v) => Array.isArray(v) && (v[0]?.uiId || v[0]?.ui_id)) ?? [];
const entries = rawEntries.map((e) => ({
  uiId: e.uiId ?? e.ui_id,
  backendStatus: e.backendStatus ?? e.backend_status,
  action: e.action ?? null,
}));
const backendRequired = entries.filter((e) => e.backendStatus === 'backend-required');

/** registry uiId 'xcp.authority.actor-mode' → ledger key 'authority.actor-mode' */
const normalize = (uiId) => String(uiId || '').replace(/^xcp\./, '');

const regKeys = new Set(backendRequired.map((e) => normalize(e.uiId)));
const ledKeys = new Set(ledger.actions.map((a) => a.ui_id));

const inRegistryOnly = [...regKeys].filter((k) => !ledKeys.has(k)).sort();
const inLedgerOnly = [...ledKeys].filter((k) => !regKeys.has(k)).sort();

// Ledger rows that are NOT backend-required in the registry anymore (status drift the other way).
const regAll = new Map(entries.map((e) => [normalize(e.uiId), e.backendStatus]));
const statusDrift = [...ledKeys]
  .filter((k) => regAll.has(k) && regAll.get(k) !== 'backend-required')
  .map((k) => ({ ui_id: k, registry_status: regAll.get(k) }));

const report = {
  registry: registryPath,
  ledger: ledgerPath,
  registry_backend_required: backendRequired.length,
  ledger_actions: ledger.actions.length,
  in_registry_not_ledger: inRegistryOnly,   // candidates to ADD to the ledger (human curation)
  in_ledger_not_registry: inLedgerOnly,     // renamed/removed in the registry, or ledger-only additions
  backend_status_drift: statusDrift,
  clean: inRegistryOnly.length === 0 && inLedgerOnly.length === 0 && statusDrift.length === 0,
};

console.log(JSON.stringify(report, null, 2));

// ── L4 · snapshot-freshness WARN (never blocking; see header) ──────────────────────────────────────
try {
  const snapRoot = `${dirname(dirname(registryPath))}`; // …/registry-snapshots
  const dirs = readdirSync(snapRoot).filter((d) => /^\d{6}$/.test(d)).sort();
  const newestSnap = dirs[dirs.length - 1];
  const ledgerDate = execSync(`git log -1 --format=%cs -- "${ledgerPath}"`, { encoding: 'utf8' }).trim(); // YYYY-MM-DD
  if (newestSnap && ledgerDate) {
    const snapMs = Date.parse(`20${newestSnap.slice(0, 2)}-${newestSnap.slice(2, 4)}-${newestSnap.slice(4, 6)}`);
    const staleDays = Math.floor((Date.parse(ledgerDate) - snapMs) / 86_400_000);
    if (staleDays > 3) {
      console.log(`compare-registry-to-ledger · FRESHNESS WARN · ledger last curated ${ledgerDate} but newest registry snapshot is ${newestSnap} (${staleDays}d older) — request a fresh ui:extract from Design`);
    }
  }
} catch { /* freshness is best-effort (no git / nonstandard layout) — never blocks the compare */ }

if (report.clean) {
  console.log('compare-registry-to-ledger · CLEAN · registry and ledger agree');
} else {
  const n = inRegistryOnly.length + inLedgerOnly.length + statusDrift.length;
  console.log(`compare-registry-to-ledger · ${n} drift(s) — curation candidates above (advisory${strict ? ', STRICT → fail' : ''})`);
  if (strict) process.exit(1);
}
