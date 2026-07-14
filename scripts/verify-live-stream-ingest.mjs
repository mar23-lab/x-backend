#!/usr/bin/env node
// scripts/verify-live-stream-ingest.mjs
//
// R53-W2 ci-local gate · MB-P push → DB → live read for the operations live stream.
//
// Proves the seam exists end-to-end at the source level: migration + DAL
// interface + DAL impl + ingest route (bearer-secret auth) + GET reads DB with
// bundle fallback + the operator-side push script. Structural (no live DB);
// runtime is exercised by the smoke + post-deploy probe.
//
// Exit 0 if all pass; 1 otherwise.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const failures = [];
async function gate(name, fn) {
  try {
    const ok = await fn();
    if (ok === true) { console.log(`  ☑ ${name}`); passed++; }
    else { console.log(`  ✗ ${name} · ${ok}`); failed++; failures.push({ name, reason: ok }); }
  } catch (e) {
    console.log(`  ✗ ${name} · threw ${e.message}`); failed++; failures.push({ name, reason: e.message });
  }
}

console.log('verify-live-stream-ingest · R53-W2 gate\n');

await gate('R53-W2: migration 013 creates operations_live_stream_snapshots (version-gated at 13)', async () => {
  const p = path.join(REPO, 'src/workers/db/migrations/013_operations_live_stream_snapshots.sql');
  if (!existsSync(p)) return 'migration 013 missing';
  const src = await fs.readFile(p, 'utf8');
  if (!/CREATE TABLE operations_live_stream_snapshots/.test(src)) return 'no CREATE TABLE';
  if (!/workers_schema_version WHERE version = 13/.test(src)) return 'not version-gated at 13';
  if (!/envelope\s+JSONB/.test(src)) return 'envelope column is not JSONB';
  if (!/idx_ols_snapshots_latest/.test(src)) return 'missing newest-snapshot index';
  return true;
});

await gate('R53-W2: DalAdapter declares get/put live-stream snapshot', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/dal/DalAdapter.ts'), 'utf8');
  if (!/getLatestLiveStreamSnapshot\(/.test(src)) return 'getLatestLiveStreamSnapshot not declared';
  if (!/putLiveStreamSnapshot\(/.test(src)) return 'putLiveStreamSnapshot not declared';
  return true;
});

await gate('R53-W2: WorkersDalAdapter implements both (newest-row read + insert)', async () => {
  // Stage 3.1 (F10 batch5): the operations_live_stream_snapshots read/insert SQL moved out of the
  // DAL god-object into ./operations-store; the DAL now thin-delegates (async getLatest…/putLive…
  // still present as delegations). Read DAL + operations-store as one combined source so the impl
  // markers (DAL delegations) and the newest-row read + INSERT SQL (now in operations-store) both
  // hold. Same retarget pattern as the inference-store / source-store smoke guards.
  const dal = await fs.readFile(path.join(REPO, 'src/workers/dal/WorkersDalAdapter.ts'), 'utf8');
  const opsStore = await fs.readFile(path.join(REPO, 'src/workers/dal/operations-store.ts'), 'utf8');
  const src = dal + '\n' + opsStore;
  if (!/async getLatestLiveStreamSnapshot/.test(src)) return 'getLatestLiveStreamSnapshot impl missing';
  if (!/async putLiveStreamSnapshot/.test(src)) return 'putLiveStreamSnapshot impl missing';
  if (!/ORDER BY generated_at DESC/.test(src)) return 'read does not select the newest snapshot';
  if (!/INSERT INTO operations_live_stream_snapshots/.test(src)) return 'put does not insert';
  return true;
});

await gate('R53-W2: ingest route exists with shared-secret bearer auth (NOT Clerk)', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/routes/mbp-projection.ts'), 'utf8');
  if (!/mbpProjectionRoute\.post\(['"]\/mbp-live-stream\/ingest['"]/.test(src)) return 'POST /mbp-live-stream/ingest route missing';
  if (!/MBP_LIVE_STREAM_INGEST_TOKEN/.test(src)) return 'ingest secret env not referenced';
  if (!/verifyIngestToken/.test(src)) return 'no verifyIngestToken auth helper';
  if (!/putLiveStreamSnapshot/.test(src)) return 'ingest does not persist via DAL';
  // must validate the payload shape
  if (!/envelope\.rows must be an array/.test(src)) return 'ingest does not validate rows[]';
  // must store under the STABLE stream key, NOT envelope.stream_id (which is a
  // unique per-generation receipt id and would never match the GET filter).
  if (/stream_id:\s*typeof envelope\.stream_id/.test(src)) {
    return 'ingest stores envelope.stream_id (per-generation id) — GET would never find the row';
  }
  if (!/stream_id:\s*['"]mbp-operations-live-stream['"]/.test(src)) {
    return 'ingest does not store under the stable stream key the GET route reads';
  }
  return true;
});

await gate('R53-W2: GET /mbp-live-stream reads DB snapshot with bundle fallback (defense in depth)', async () => {
  const src = await fs.readFile(path.join(REPO, 'src/workers/routes/mbp-projection.ts'), 'utf8');
  if (!/getLatestLiveStreamSnapshot\(['"]mbp-operations-live-stream['"]\)/.test(src)) return 'GET does not query the DB snapshot';
  if (!/bundle_fallback/.test(src)) return 'no bundle fallback path';
  if (!/db_live/.test(src)) return 'no db_live served_from marker';
  // the static import must remain as the fallback source
  if (!/import operationsLiveStream from/.test(src)) return 'bundle import removed — fallback would break';
  return true;
});

await gate('R53-W2: operator-side push script posts the envelope to the ingest endpoint', async () => {
  const p = path.join(REPO, 'scripts/push-operations-live-stream-to-workers.mjs');
  if (!existsSync(p)) return 'push script missing';
  const src = await fs.readFile(p, 'utf8');
  if (!/\/api\/v1\/mbp-live-stream\/ingest/.test(src)) return 'push script does not target the ingest endpoint';
  if (!/MBP_LIVE_STREAM_INGEST_TOKEN/.test(src)) return 'push script does not present the bearer secret';
  if (!/--dry-run/.test(src)) return 'push script has no --dry-run preview mode';
  if (!/flagVal\(['"]--receipt['"]\)/.test(src)) return 'push script has no --receipt override for local evidence';
  if (!/XLOOOP_LIVE_STREAM_PUSH_RECEIPT_PATH/.test(src)) return 'push script has no env override for receipt path';
  if (!/operations_live_stream_push_receipt\.v1/.test(src)) return 'push script does not write the typed push receipt schema';
  if (!/xlooop-live-stream-push-receipt\.json/.test(src)) return 'push script does not write a local freshness receipt';
  if (!/writeFileSync\(RECEIPT_PATH/.test(src)) return 'push script does not persist the local freshness receipt';
  if (!/secret_included:\s*false/.test(src)) return 'push receipt does not explicitly exclude secrets';
  if (!/assertNoReadOnlyVerificationLock/.test(src)) return 'push script does not respect read-only verification lock';
  return true;
});

await gate('R53-W2: launchd cron push uses untracked temp envelope', async () => {
  const gen = await fs.readFile(path.join(REPO, 'scripts/generate-operations-live-stream.mjs'), 'utf8');
  if (!/flagVal\(['"]--out['"]\)/.test(gen)) return 'generator does not support --out override';
  const cronPath = path.join(REPO, 'scripts/livestream-push-cron.sh');
  if (!existsSync(cronPath)) return 'livestream cron wrapper missing';
  const src = await fs.readFile(cronPath, 'utf8');
  if (!/TEMP_ENVELOPE=/.test(src)) return 'cron wrapper does not create a temp envelope';
  if (!/BUILD_TIMESTAMP_ISO="\$RUNTIME_GENERATED_AT"\s+node scripts\/generate-operations-live-stream\.mjs/.test(src)) return 'cron wrapper does not force a runtime timestamp for the temp envelope';
  if (!/generate-operations-live-stream\.mjs --out="\$TEMP_ENVELOPE"/.test(src)) return 'cron wrapper does not generate to temp envelope';
  if (!/push-operations-live-stream-to-workers\.mjs --file="\$PUSH_FILE"/.test(src)) return 'cron wrapper does not push selected envelope file';
  return true;
});

await gate('R53-W2: cron freshness verifier prefers runtime push receipt over tracked snapshot', async () => {
  const src = await fs.readFile(path.join(REPO, 'scripts/verify-cron-freshness.mjs'), 'utf8');
  if (!/xlooop-live-stream-push-receipt\.json/.test(src)) return 'cron freshness verifier does not read the runtime push receipt';
  if (!/runtime push receipt/.test(src)) return 'cron freshness verifier does not report runtime receipt source';
  if (!/source_mode is .*expected staged_snapshot/.test(src)) return 'cron freshness verifier does not guard receipt source_mode';
  if (!/STREAM_PATH/.test(src)) return 'cron freshness verifier lost tracked snapshot fallback';
  return true;
});

console.log(`\nverify-live-stream-ingest · ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name} · ${f.reason}`);
  process.exit(1);
}
process.exit(0);
