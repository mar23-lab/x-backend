#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = readJson('data/ecosystem-capability-consumer-manifest.json');
const pack = readJson(manifest.consumed_contract_pack_path);
const findings = [];

const packBytes = fs.readFileSync(path.join(repoRoot, manifest.consumed_contract_pack_path));
const packFileSha = sha256(packBytes);
const mbpRegistry = loadMbpRegistry();

check(manifest.schema_version === 'xcp.capability_consumer_manifest.v1', 'manifest_schema', 'manifest schema must be xcp.capability_consumer_manifest.v1');
check(manifest.consumer_repo === 'Xlooop-XCP-demo', 'consumer_repo', 'consumer_repo must be Xlooop-XCP-demo');
check(manifest.governance_authority === 'MB-P', 'governance_authority', 'MB-P must remain governance authority');
check(pack.schema_version === 'xcp.ecosystem_leverage_contract_pack.v1', 'pack_schema', 'vendored pack must use xcp.ecosystem_leverage_contract_pack.v1');
check(pack.authority === 'xcp-platform', 'pack_authority', 'XCP must publish the product-neutral pack');
check(pack.governance_authority === 'MB-P', 'pack_governance_authority', 'pack must name MB-P governance authority');
check(manifest.consumed_contract_pack_sha256 === pack.contract_pack_sha256, 'pack_contract_sha', 'manifest contract sha must match vendored pack contract_pack_sha256');
check(manifest.consumed_contract_pack_file_sha256 === packFileSha, 'pack_file_sha', 'manifest file sha must match vendored pack bytes');
for (const contractName of [
  'EcosystemCapabilityLeverageEntry',
  'ReuseClass',
  'CapabilityAdoptionReceipt',
  'CapabilityConsumerManifest',
  'CapabilityEvidenceRef',
]) {
  check((pack.required_contracts || []).includes(contractName), `pack_contract:${contractName}`, `pack must include ${contractName}`);
}

const allowedReuseClasses = new Set(pack.reuse_classes || []);
const capabilityIds = new Set(mbpRegistry.map((entry) => entry.capability_id));
for (const capability of manifest.adopted_capabilities || []) {
  const id = capability.capability_id || '<missing>';
  check(capabilityIds.has(id), `mbp_registry:${id}`, `capability ${id} must exist in MB-P leverage registry`);
  check(allowedReuseClasses.has(capability.reuse_class), `reuse_class:${id}`, `capability ${id} must use a pack-declared reuse_class`);
  check(Boolean(capability.local_surface), `local_surface:${id}`, `capability ${id} must declare local_surface`);
  check(Boolean(capability.evidence_ref), `evidence_ref:${id}`, `capability ${id} must declare evidence_ref`);
  check(Boolean(capability.verifier), `verifier:${id}`, `capability ${id} must declare verifier`);
  check(['adopted', 'proposed', 'blocked'].includes(capability.status), `status:${id}`, `capability ${id} must use valid adoption status`);
  check(!/\.\.\//.test(capability.local_surface), `no_parent_path:${id}`, `capability ${id} must not use parent path traversal`);
  check(!/^src\//.test(capability.local_surface), `no_app_internal_surface:${id}`, `capability ${id} must not consume app internals directly`);
}

const manifestText = readText('data/ecosystem-capability-consumer-manifest.json');
for (const forbidden of [
  '../xcp-platform',
  'Xlooop-XCP-demo/src',
  'xcp-platform/apps/',
  'public_ready',
  'public_claim_allowed": true',
]) {
  check(!manifestText.includes(forbidden), `forbidden:${forbidden}`, `manifest must not include forbidden pattern ${forbidden}`);
}

if (findings.length) {
  console.error('ecosystem-leverage-consumption: FAIL');
  for (const finding of findings) console.error(`  FAIL ${finding.id}: ${finding.message}`);
  process.exit(1);
}

console.log(`ecosystem-leverage-consumption: PASS (${manifest.consumed_contract_pack_sha256})`);

function loadMbpRegistry() {
  const mbpRoot = process.env.MBP_ROOT || '/Users/maratbasyrov/WIP/MB-P';
  const registryPath = path.join(mbpRoot, '_sys/xcp-system/governance/ECOSYSTEM_CAPABILITY_LEVERAGE_REGISTRY.yml');
  if (!fs.existsSync(registryPath)) {
    check(false, 'mbp_registry_missing', `cannot find MB-P registry at ${registryPath}`);
    return [];
  }
  const text = fs.readFileSync(registryPath, 'utf8');
  const ids = [...text.matchAll(/^\s*- capability_id:\s*"([^"]+)"/gm)].map((match) => match[1]);
  return ids.map((capability_id) => ({ capability_id }));
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function readText(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function check(ok, id, message) {
  if (!ok) findings.push({ id, message });
}
