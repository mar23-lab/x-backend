#!/usr/bin/env node
// Produce sanitized pilot-shadow signed-chain evidence from a live capture artifact.
//
// This script is intentionally a producer, not a verifier bypass. It refuses raw mail/document bodies,
// requires a signing secret, requires pilot-shadow/nonproduction provenance, signs a canonical per-chain
// payload with HS256, and then writes the evidence artifact consumed by
// verify-pilot-shadow-signed-chain-evidence.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHmac, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SELF_TEST = process.argv.includes('--self-test');
const CAPTURE_FILE = process.env.XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_CAPTURE_FILE || '';
const EVIDENCE_FILE = process.env.XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_EVIDENCE_FILE || '';
const HEALTH_FILE = process.env.XLOOOP_PILOT_SHADOW_HEALTH_FILE || '';
const SIGNING_SECRET = process.env.RESOLUTION_RECEIPT_SIGNING_SECRET || process.env.XLOOOP_SIGNED_CHAIN_SIGNING_SECRET || '';
const SIGNING_KEY_ID = process.env.RESOLUTION_RECEIPT_SIGNING_KEY_ID || process.env.XLOOOP_SIGNED_CHAIN_SIGNING_KEY_ID || 'default';
const RUN_ID = process.env.XLOOOP_SIGNED_CHAIN_RUN_ID || `signed-chain-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}`;
const VERIFY_AFTER_WRITE = process.env.XLOOOP_SIGNED_CHAIN_VERIFY_AFTER_WRITE !== '0';

if (SELF_TEST) {
  await runSelfTest();
  process.exit(0);
}

try {
  const evidence = await produceEvidence({
    captureFile: CAPTURE_FILE,
    evidenceFile: EVIDENCE_FILE,
    healthFile: HEALTH_FILE,
    signingSecret: SIGNING_SECRET,
    signingKeyId: SIGNING_KEY_ID,
    runId: RUN_ID,
  });
  fs.mkdirSync(path.dirname(path.resolve(EVIDENCE_FILE)), { recursive: true });
  fs.writeFileSync(path.resolve(EVIDENCE_FILE), `${JSON.stringify(evidence, null, 2)}\n`);

  if (VERIFY_AFTER_WRITE) {
    const verify = spawnSync(process.execPath, ['scripts/verify-pilot-shadow-signed-chain-evidence.mjs', '--strict'], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      env: { ...process.env, XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_EVIDENCE_FILE: path.resolve(EVIDENCE_FILE) },
      encoding: 'utf8',
    });
    if (verify.status !== 0) {
      process.stderr.write(verify.stdout || '');
      process.stderr.write(verify.stderr || '');
      throw new Error(`written evidence failed strict verifier with status ${verify.status}`);
    }
  }

  console.log(JSON.stringify({
    schema_id: 'xlooop.pilot_shadow_signed_chain_producer.report.v1',
    status: 'PASS',
    evidence_file: path.resolve(EVIDENCE_FILE),
    chains: evidence.chains.map((chain) => ({ kind: chain.kind, signed_payload_sha256: chain.signed_payload_sha256 })),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    schema_id: 'xlooop.pilot_shadow_signed_chain_producer.report.v1',
    status: 'FAIL',
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}

async function produceEvidence({ captureFile, evidenceFile, healthFile, signingSecret, signingKeyId, runId }) {
  if (!captureFile) throw new Error('XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_CAPTURE_FILE is required');
  if (!evidenceFile) throw new Error('XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_EVIDENCE_FILE is required');
  if (!signingSecret) throw new Error('RESOLUTION_RECEIPT_SIGNING_SECRET or XLOOOP_SIGNED_CHAIN_SIGNING_SECRET is required');
  if (!/^[a-zA-Z0-9_.:-]{8,120}$/.test(runId)) throw new Error('run id must be 8-120 safe characters');

  const resolvedCapture = path.resolve(captureFile);
  if (!fs.existsSync(resolvedCapture)) throw new Error(`capture file not found: ${resolvedCapture}`);
  if (/(^|[/\\])[^/\\]*(?:schema\.)?example\.json$/i.test(resolvedCapture)) throw new Error('example/schema capture paths are rejected');

  const captureSource = fs.readFileSync(resolvedCapture, 'utf8');
  const capture = JSON.parse(captureSource);
  const captureHash = sha256Hex(captureSource);
  validateCapture(capture);

  const health = await readHealth(capture.api_base, healthFile);
  const backendBuildSha = String(health.build || health.build_sha || health.backend_build_sha || '').trim();
  if (!/^[0-9a-f]{40}$/.test(backendBuildSha)) throw new Error('pilot-shadow health did not provide a 40-char backend build sha');
  const healthEnvironment = String(health.environment || '').trim();
  const healthAuthority = String(health.authority || '').trim();
  if (healthEnvironment && healthEnvironment !== 'pilot-shadow') throw new Error(`health environment is not pilot-shadow: ${healthEnvironment}`);
  if (healthAuthority && healthAuthority !== 'shadow') throw new Error(`health authority is not shadow: ${healthAuthority}`);

  const capturedAt = new Date().toISOString();
  const chains = capture.chains.map((chain) => signChain(chain, signingSecret, signingKeyId, capturedAt));
  return {
    schema_id: 'xlooop.pilot_shadow_signed_chain_evidence.v1',
    evidence_class: 'pilot_shadow_live_signed_chain',
    environment: 'pilot-shadow',
    authority: 'shadow',
    api_base: capture.api_base,
    backend_build_sha: backendBuildSha,
    generated_at: capturedAt,
    producer: {
      name: 'x-backend.pilot-shadow-signed-chain-producer',
      version: 'v1',
      kind: 'live_capture',
      run_id: runId,
      captured_at: capturedAt,
      input_capture_sha256: captureHash,
      nonproduction_origin_verified: true,
      authenticated_session_verified: true,
      manual: false,
      synthetic: false,
    },
    chains,
  };
}

function validateCapture(capture) {
  const errors = [];
  if (!capture || typeof capture !== 'object') errors.push('capture');
  if (capture.schema_id !== 'xlooop.pilot_shadow_signed_chain_capture.v1') errors.push('schema_id');
  if (capture.environment !== 'pilot-shadow') errors.push('environment');
  if (capture.authority !== 'shadow') errors.push('authority');
  if (!isPilotShadowApi(capture.api_base)) errors.push('api_base');
  if (capture.nonproduction_origin_verified !== true) errors.push('nonproduction_origin_verified');
  if (capture.authenticated_session_verified !== true) errors.push('authenticated_session_verified');
  const rawKeys = rawBodyKeys(capture);
  if (rawKeys.length) errors.push(`raw_body_keys:${rawKeys.join(',')}`);
  if (/(placeholder|example|changeme|todo)/i.test(JSON.stringify(capture))) errors.push('placeholder_markers');
  const chains = Array.isArray(capture.chains) ? capture.chains : [];
  const kinds = new Set(chains.map((chain) => chain?.kind));
  if (!kinds.has('gmail') || !kinds.has('document')) errors.push('required_chain_kinds');
  for (const [index, chain] of chains.entries()) errors.push(...problemsForCaptureChain(chain, index));
  if (errors.length) throw new Error(`invalid signed-chain capture: ${[...new Set(errors)].join(', ')}`);
}

function problemsForCaptureChain(chain, index) {
  const problems = [];
  const prefix = `chains[${index}]`;
  if (!chain || typeof chain !== 'object') return [prefix];
  for (const field of ['kind', 'workspace_id', 'actor_id', 'receipt_id', 'operation_event_id', 'audit_event_id']) {
    if (typeof chain[field] !== 'string' || chain[field].trim() === '') problems.push(`${prefix}.${field}`);
  }
  if (!['gmail', 'document'].includes(chain.kind)) problems.push(`${prefix}.kind`);
  if (chain.kind === 'gmail') {
    for (const field of ['provider', 'source_connection_id', 'source_event_id', 'message_ref_hash']) {
      if (typeof chain[field] !== 'string' || chain[field].trim() === '') problems.push(`${prefix}.${field}`);
    }
    if (chain.provider !== 'gmail') problems.push(`${prefix}.provider`);
    if (!/^[0-9a-f]{64}$/.test(chain.message_ref_hash || '')) problems.push(`${prefix}.message_ref_hash`);
    if (chain.workspace_binding_verified !== true) problems.push(`${prefix}.workspace_binding_verified`);
    if (chain.restricted_scope_verified !== true) problems.push(`${prefix}.restricted_scope_verified`);
  }
  if (chain.kind === 'document') {
    for (const field of ['document_id', 'content_hash', 'document_access_log_id']) {
      if (typeof chain[field] !== 'string' || chain[field].trim() === '') problems.push(`${prefix}.${field}`);
    }
    if (!/^[0-9a-f]{64}$/.test(chain.content_hash || '')) problems.push(`${prefix}.content_hash`);
    if (!Number.isInteger(Number(chain.version)) || Number(chain.version) < 1) problems.push(`${prefix}.version`);
    if (chain.workspace_binding_verified !== true) problems.push(`${prefix}.workspace_binding_verified`);
    if (chain.content_hash_verified !== true) problems.push(`${prefix}.content_hash_verified`);
  }
  return problems;
}

function signChain(chain, secret, keyId, verifiedAt) {
  const payload = canonicalChainPayload(chain, verifiedAt);
  return {
    ...chain,
    signed_payload_sha256: sha256Hex(payload),
    signature: { alg: 'HS256', value: hmacBase64Url(secret, payload), key_id: keyId },
    verified_at: verifiedAt,
  };
}

function canonicalChainPayload(chain, verifiedAt) {
  const base = {
    schema_id: 'xlooop.pilot_shadow_signed_chain_payload.v1',
    kind: chain.kind,
    workspace_id: chain.workspace_id,
    actor_id: chain.actor_id,
    receipt_id: chain.receipt_id,
    operation_event_id: chain.operation_event_id,
    audit_event_id: chain.audit_event_id,
    verified_at: verifiedAt,
  };
  if (chain.kind === 'gmail') {
    return JSON.stringify({
      ...base,
      provider: chain.provider,
      source_connection_id: chain.source_connection_id,
      source_event_id: chain.source_event_id,
      message_ref_hash: chain.message_ref_hash,
      workspace_binding_verified: chain.workspace_binding_verified,
      restricted_scope_verified: chain.restricted_scope_verified,
    });
  }
  return JSON.stringify({
    ...base,
    document_id: chain.document_id,
    content_hash: chain.content_hash,
    version: Number(chain.version),
    document_access_log_id: chain.document_access_log_id,
    workspace_binding_verified: chain.workspace_binding_verified,
    content_hash_verified: chain.content_hash_verified,
  });
}

async function readHealth(apiBase, healthFile) {
  if (healthFile) return JSON.parse(fs.readFileSync(path.resolve(healthFile), 'utf8'));
  const response = await fetch(`${apiBase.replace(/\/+$/, '')}/api/v1/health?cb=signed-chain-${Date.now()}`);
  if (!response.ok) throw new Error(`pilot-shadow health fetch failed: ${response.status}`);
  return response.json();
}

function rawBodyKeys(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const problems = [];
  for (const [key, child] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (/(^|_)(body|raw_body|message_body|document_body|mail_body|email_body|content_text|extracted_text)$/i.test(key)) {
      problems.push(current);
    }
    if (child && typeof child === 'object') problems.push(...rawBodyKeys(child, current));
  }
  return problems;
}

function isPilotShadowApi(apiBase) {
  return typeof apiBase === 'string' &&
    /^https:\/\//.test(apiBase) &&
    apiBase !== 'https://api.xlooop.com' &&
    /xlooop-api-pilot-shadow/.test(apiBase);
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function hmacBase64Url(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

async function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlooop-signed-chain-producer-'));
  const captureFile = path.join(tmp, 'capture.json');
  const healthFile = path.join(tmp, 'health.json');
  const evidenceFile = path.join(tmp, 'evidence.json');
  const capture = {
    schema_id: 'xlooop.pilot_shadow_signed_chain_capture.v1',
    environment: 'pilot-shadow',
    authority: 'shadow',
    api_base: 'https://xlooop-api-pilot-shadow.xlooop23.workers.dev',
    nonproduction_origin_verified: true,
    authenticated_session_verified: true,
    chains: [
      {
        kind: 'gmail',
        provider: 'gmail',
        workspace_id: 'ws_a',
        actor_id: 'usr_a',
        source_connection_id: 'src_gmail_a',
        source_event_id: 'evt_gmail_a',
        message_ref_hash: 'b'.repeat(64),
        receipt_id: 'rcpt_gmail_a',
        operation_event_id: 'op_evt_gmail_a',
        audit_event_id: 'audit_gmail_a',
        workspace_binding_verified: true,
        restricted_scope_verified: true,
      },
      {
        kind: 'document',
        workspace_id: 'ws_a',
        actor_id: 'usr_a',
        document_id: 'doc_a',
        content_hash: 'e'.repeat(64),
        version: 1,
        document_access_log_id: 'doc_access_a',
        receipt_id: 'rcpt_doc_a',
        operation_event_id: 'op_evt_doc_a',
        audit_event_id: 'audit_doc_a',
        workspace_binding_verified: true,
        content_hash_verified: true,
      },
    ],
  };
  fs.writeFileSync(captureFile, JSON.stringify(capture));
  fs.writeFileSync(healthFile, JSON.stringify({ build: 'a'.repeat(40), environment: 'pilot-shadow', authority: 'shadow' }));
  const evidence = await produceEvidence({
    captureFile,
    evidenceFile,
    healthFile,
    signingSecret: 'self-test-secret',
    signingKeyId: 'self-test-key',
    runId: 'signed-chain-self-test-1',
  });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  const verify = spawnSync(process.execPath, ['scripts/verify-pilot-shadow-signed-chain-evidence.mjs', '--strict'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { ...process.env, XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_EVIDENCE_FILE: evidenceFile },
    encoding: 'utf8',
  });
  const rawRejected = (() => {
    try {
      validateCapture({ ...capture, chains: [{ ...capture.chains[0], message_body: 'forbidden' }] });
      return false;
    } catch {
      return true;
    }
  })();
  if (verify.status !== 0 || !rawRejected || !evidence.producer.input_capture_sha256 || evidence.chains.some((chain) => chain.signature?.alg !== 'HS256')) {
    console.error(JSON.stringify({ verify_status: verify.status, verify_stdout: verify.stdout, rawRejected, evidence }, null, 2));
    throw new Error('self-test failed');
  }
  console.log('PASS pilot-shadow signed chain producer self-test');
}
