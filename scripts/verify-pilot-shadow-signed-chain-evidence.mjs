#!/usr/bin/env node
// Strict pilot-shadow signed chain evidence verifier.
//
// This is the live proof lane for the commercial-completion blocker:
// "signed Gmail and document receipt chains." It does not create authority and
// does not touch production. It verifies a sanitized evidence artifact produced
// from pilot-shadow only, then emits an authority boolean other gates can cite.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const strict =
  process.argv.includes('--strict') ||
  process.env.XLOOOP_REQUIRE_PILOT_SHADOW_SIGNED_CHAINS === '1';
const selfTest = process.argv.includes('--self-test');
const evidenceFile = process.env.XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_EVIDENCE_FILE || '';
const maxAgeDays = Number(process.env.XLOOOP_SIGNED_CHAIN_MAX_AGE_DAYS || 7);
const checks = [];
const failures = [];
const warnings = [];
let authority = false;

function addCheck(id, ok, details = {}, options = {}) {
  const status = ok ? 'PASS' : (options.warnOnly ? 'WARN' : 'FAIL');
  const row = { id, status, ...details };
  checks.push(row);
  if (!ok && options.block) failures.push(row);
  if (!ok && options.warnOnly) warnings.push(row);
  return row;
}

if (selfTest) {
  runSelfTest();
  process.exit(0);
}

addCheck('evidence_file_configured', Boolean(evidenceFile), {
  env: 'XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_EVIDENCE_FILE',
  evidence_file: evidenceFile || null,
}, { block: strict, warnOnly: !strict });

if (evidenceFile) {
  const resolved = path.resolve(evidenceFile);
  addCheck('evidence_file_exists', fs.existsSync(resolved), { evidence_file: resolved }, { block: strict, warnOnly: !strict });
  addCheck('evidence_file_not_example', !/(^|[/\\])[^/\\]*(?:schema\.)?example\.json$/i.test(resolved), {
    evidence_file: resolved,
  }, { block: strict, warnOnly: !strict });
  if (fs.existsSync(resolved)) {
    try {
      const evidence = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      addCheck('evidence_file_json', true, { evidence_file: resolved });
      verifyEvidence(evidence, resolved);
    } catch (error) {
      addCheck('evidence_file_json', false, { evidence_file: resolved, error: error.message }, { block: true });
    }
  }
}

const status = failures.length ? 'FAIL' : 'PASS';
const report = {
  schema_id: 'xlooop.pilot_shadow_signed_chain_evidence.verifier.v1',
  status,
  strict,
  pilot_shadow_signed_chain_authority: authority,
  evidence_file_configured: Boolean(evidenceFile),
  checks,
  failures,
  warnings,
  conclusion: authority
    ? 'Pilot-shadow signed Gmail and document chain evidence authority is present.'
    : 'Signed Gmail/document chain evidence remains absent or non-authoritative; pilot-shadow completion cannot claim this live gate yet.',
};

console.log(JSON.stringify(report, null, 2));
process.exit(status === 'PASS' ? 0 : 1);

function verifyEvidence(e, evidencePath) {
  const missing = [];
  for (const field of [
    'schema_id',
    'evidence_class',
    'environment',
    'authority',
    'api_base',
    'backend_build_sha',
    'generated_at',
    'producer',
    'chains',
  ]) {
    if (e[field] === undefined || e[field] === '') missing.push(field);
  }
  addCheck('required_fields_present', missing.length === 0, { missing }, { block: true });
  addCheck('schema_valid', e.schema_id === 'xlooop.pilot_shadow_signed_chain_evidence.v1', {
    schema_id: e.schema_id || null,
  }, { block: true });
  addCheck('evidence_class_valid', e.evidence_class === 'pilot_shadow_live_signed_chain', {
    evidence_class: e.evidence_class || null,
  }, { block: true });
  addCheck('environment_is_pilot_shadow', e.environment === 'pilot-shadow', {
    environment: e.environment || null,
  }, { block: true });
  addCheck('authority_is_shadow', e.authority === 'shadow', {
    authority: e.authority || null,
  }, { block: true });
  addCheck('api_base_is_pilot_shadow_not_production', isPilotShadowApi(e.api_base), {
    api_base: e.api_base || null,
  }, { block: true });
  addCheck('backend_sha_valid', /^[0-9a-f]{40}$/.test(e.backend_build_sha || ''), {
    backend_build_sha: e.backend_build_sha || null,
  }, { block: true });

  const generatedMs = Date.parse(e.generated_at || '');
  const ageDays = Number.isNaN(generatedMs)
    ? null
    : Math.round(((Date.now() - generatedMs) / 864e5) * 100) / 100;
  addCheck('generated_at_parses', !Number.isNaN(generatedMs), {
    generated_at: e.generated_at || null,
  }, { block: true });
  addCheck('evidence_fresh_enough', ageDays !== null && ageDays >= 0 && ageDays <= maxAgeDays, {
    generated_age_days: ageDays,
    max_age_days: maxAgeDays,
  }, { block: true });
  addCheck('no_placeholder_markers', !/(placeholder|example|changeme|todo)/i.test(JSON.stringify(e)), {
    forbidden_markers: ['placeholder', 'example', 'changeme', 'todo'],
  }, { block: true });
  addCheck('no_raw_mail_or_document_body_keys', rawBodyKeys(e).length === 0, {
    raw_body_keys: rawBodyKeys(e),
  }, { block: true });
  const producerProblems = problemsForProducer(e.producer);
  addCheck('producer_provenance_complete', producerProblems.length === 0, {
    producer_problems: producerProblems,
  }, { block: true });

  const chains = Array.isArray(e.chains) ? e.chains : [];
  const kinds = new Set(chains.map((chain) => chain?.kind));
  addCheck('required_chain_kinds_present', kinds.has('gmail') && kinds.has('document'), {
    chain_kinds: [...kinds].filter(Boolean).sort(),
  }, { block: true });

  const chainProblems = chains.flatMap((chain, index) => problemsForChain(chain, index));
  addCheck('chains_complete', chainProblems.length === 0, {
    chain_problems: chainProblems,
  }, { block: true });

  authority =
    failures.length === 0 &&
    e.evidence_class === 'pilot_shadow_live_signed_chain' &&
    e.environment === 'pilot-shadow' &&
    e.authority === 'shadow' &&
    isPilotShadowApi(e.api_base) &&
    producerProblems.length === 0 &&
    kinds.has('gmail') &&
    kinds.has('document') &&
    !/(^|[/\\])[^/\\]*(?:schema\.)?example\.json$/i.test(evidencePath);

  addCheck('pilot_shadow_signed_chain_authority', authority, {
    evidence_file: evidencePath,
  }, { block: strict, warnOnly: !strict });
}

function problemsForProducer(producer) {
  const problems = [];
  if (!producer || typeof producer !== 'object') return ['producer'];
  const requiredStrings = ['name', 'version', 'run_id', 'captured_at'];
  for (const field of requiredStrings) {
    if (typeof producer[field] !== 'string' || producer[field].trim() === '') problems.push(`producer.${field}`);
  }
  if (producer.name !== 'x-backend.pilot-shadow-signed-chain-producer') problems.push('producer.name');
  if (producer.kind !== 'live_capture') problems.push('producer.kind');
  if (producer.manual === true || producer.hand_authored === true || producer.synthetic === true) {
    problems.push('producer.manual_or_synthetic');
  }
  if (producer.nonproduction_origin_verified !== true) problems.push('producer.nonproduction_origin_verified');
  if (producer.authenticated_session_verified !== true) problems.push('producer.authenticated_session_verified');
  if (Number.isNaN(Date.parse(producer.captured_at || ''))) problems.push('producer.captured_at');
  if (!/^[a-zA-Z0-9_.:-]{8,120}$/.test(producer.run_id || '')) problems.push('producer.run_id');
  return [...new Set(problems)];
}

function problemsForChain(chain, index) {
  const problems = [];
  if (!chain || typeof chain !== 'object') return [`chains[${index}]`];
  const prefix = `chains[${index}]`;
  for (const field of [
    'kind',
    'workspace_id',
    'actor_id',
    'receipt_id',
    'operation_event_id',
    'audit_event_id',
    'signed_payload_sha256',
    'signature',
    'verified_at',
  ]) {
    if (chain[field] === undefined || chain[field] === '') problems.push(`${prefix}.${field}`);
  }
  if (!['gmail', 'document'].includes(chain.kind)) problems.push(`${prefix}.kind`);
  if (!/^[0-9a-f]{64}$/.test(chain.signed_payload_sha256 || '')) problems.push(`${prefix}.signed_payload_sha256`);
  if (Number.isNaN(Date.parse(chain.verified_at || ''))) problems.push(`${prefix}.verified_at`);
  if (!signatureOk(chain.signature)) problems.push(`${prefix}.signature`);

  if (chain.kind === 'gmail') {
    for (const field of ['provider', 'source_connection_id', 'source_event_id', 'message_ref_hash']) {
      if (typeof chain[field] !== 'string' || chain[field].trim() === '') problems.push(`${prefix}.${field}`);
    }
    if (chain.provider !== 'gmail') problems.push(`${prefix}.provider`);
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

  return [...new Set(problems)];
}

function signatureOk(signature) {
  if (!signature || typeof signature !== 'object') return false;
  if (!['HS256', 'HMAC-SHA256', 'Ed25519'].includes(signature.alg)) return false;
  return typeof signature.value === 'string' && signature.value.length >= 32;
}

function isPilotShadowApi(apiBase) {
  return typeof apiBase === 'string' &&
    /^https:\/\//.test(apiBase) &&
    apiBase !== 'https://api.xlooop.com' &&
    /xlooop-api-pilot-shadow/.test(apiBase);
}

function rawBodyKeys(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const problems = [];
  for (const [key, child] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (/(^|_)(body|raw_body|message_body|document_body|mail_body|email_body|content_text)$/i.test(key)) {
      problems.push(current);
    }
    if (child && typeof child === 'object') problems.push(...rawBodyKeys(child, current));
  }
  return problems;
}

function runSelfTest() {
  const now = new Date().toISOString();
  const valid = {
    schema_id: 'xlooop.pilot_shadow_signed_chain_evidence.v1',
    evidence_class: 'pilot_shadow_live_signed_chain',
    environment: 'pilot-shadow',
    authority: 'shadow',
    api_base: 'https://xlooop-api-pilot-shadow.xlooop23.workers.dev',
    backend_build_sha: 'a'.repeat(40),
    generated_at: now,
    producer: {
      name: 'x-backend.pilot-shadow-signed-chain-producer',
      version: 'self-test',
      kind: 'live_capture',
      run_id: 'signed-chain-self-test-1',
      captured_at: now,
      nonproduction_origin_verified: true,
      authenticated_session_verified: true,
      manual: false,
      synthetic: false,
    },
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
        signed_payload_sha256: 'c'.repeat(64),
        signature: { alg: 'HS256', value: 'd'.repeat(64) },
        workspace_binding_verified: true,
        restricted_scope_verified: true,
        verified_at: now,
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
        signed_payload_sha256: 'f'.repeat(64),
        signature: { alg: 'HS256', value: 'a'.repeat(64) },
        workspace_binding_verified: true,
        content_hash_verified: true,
        verified_at: now,
      },
    ],
  };

  const previousFailures = failures.length;
  verifyEvidence(valid, '/tmp/pilot-shadow-signed-chain-live.json');
  const validOk = failures.length === previousFailures && authority === true;
  const bodyProblem = rawBodyKeys({ chains: [{ kind: 'gmail', message_body: 'forbidden' }] }).length === 1;
  const prodRejected = !isPilotShadowApi('https://api.xlooop.com');
  const producerProblem = problemsForProducer({ ...valid.producer, manual: true }).includes('producer.manual_or_synthetic');
  if (!validOk || !bodyProblem || !prodRejected || !producerProblem) {
    console.error(JSON.stringify({ validOk, bodyProblem, prodRejected, producerProblem, checks, failures }, null, 2));
    throw new Error('self-test failed');
  }
  console.log('PASS pilot-shadow signed chain evidence self-test');
}
