#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scannedRoots = [
  'data/customer-onboarding-read-model.json',
  'templates/customer-ecosystem-template',
];

const forbiddenPatterns = [
  { id: 'hard_rule_id', pattern: /\bHR-[A-Z0-9][A-Z0-9-]*-\d+\b/ },
  { id: 'mbp_internal_path', pattern: /\/Users\/maratbasyrov\/WIP\/MB-P\b|_sys\/xcp-system\b/i },
  // operator_local_abs_path: ANY operator-machine absolute home path must never ship in a
  // customer-facing artifact (info disclosure: operator username + local dir structure). The
  // mbp_internal_path rule above only caught /WIP/MB-P; this caught the 2026-06-14 leak
  // "/Users/maratbasyrov/Andrey P - Ecosystem" in customer-onboarding-read-model.json#ecosystem_backbone.local_path.
  { id: 'operator_local_abs_path', pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { id: 'engine_formula_or_weights', pattern: /\bengine weights?\b|\bscoring weights?\b|\bengine formula\b/i },
  { id: 'prompt_chain', pattern: /\bprompt chain\b|\bprompt text\b/i },
  { id: 'private_architecture_map', pattern: /\barchitecture dependency map\b|\bmemory architecture internals?\b|\bgraph architecture internals?\b/i },
  { id: 'mbp_retrospective', pattern: /\bMB-P retrospectives?\b/i },
  { id: 'raw_private_marker', pattern: /oauth_token_value|access token|client name:|property address:|inspection photo|raw report/i },
];

const failures = [];
const files = listFiles(scannedRoots);

for (const file of files) {
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  for (const check of forbiddenPatterns) {
    if (check.pattern.test(text)) {
      failures.push(`${file}: customer-safe surface contains forbidden internal/private marker ${check.id}`);
    }
  }
}

const model = readJson('data/customer-onboarding-read-model.json');
const policy = model.customer_safe_projection_policy || {};
for (const field of ['blocked', 'risk_lane', 'safe_explanation', 'next_action', 'receipt_id']) {
  if (!policy.allowed_reason_fields?.includes(field)) failures.push(`customer_safe_projection_policy missing allowed field ${field}`);
}
for (const field of ['internal_hard_rule_id', 'engine_weight', 'prompt_chain', 'mbp_graph_reference']) {
  if (!policy.forbidden_customer_visible_fields?.includes(field)) failures.push(`customer_safe_projection_policy missing forbidden field ${field}`);
}
if (!policy.tenant_watermark || !policy.redaction_marker) failures.push('projection policy must include tenant watermark and redaction marker');

emit('verify-customer-ip-boundary', failures, { scanned_files: files.length });

function listFiles(roots) {
  const out = [];
  for (const root of roots) {
    const absolute = path.join(repoRoot, root);
    if (!fs.existsSync(absolute)) {
      failures.push(`missing scan root ${root}`);
      continue;
    }
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
      out.push(root);
      continue;
    }
    walk(root, out);
  }
  return out;
}

function walk(relativeDir, out) {
  for (const entry of fs.readdirSync(path.join(repoRoot, relativeDir), { withFileTypes: true })) {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) walk(relative, out);
    else out.push(relative);
  }
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function emit(verifier, failures, metrics) {
  const status = failures.length ? 'FAIL' : 'PASS';
  console.log(`${verifier} · ${status} · scanned=${metrics.scanned_files}`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}
