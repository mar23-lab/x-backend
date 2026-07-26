#!/usr/bin/env node
// Build the sanitized signed-chain capture from actual pilot-shadow API responses.
// This script does not accept manually supplied receipt/event identifiers: they
// must be present and mutually consistent in the captured server responses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SELF_TEST = process.argv.includes('--self-test');

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);
}

try {
  const capture = buildCapture({
    gmailFile: process.env.XLOOOP_SIGNED_CHAIN_GMAIL_SYNC_RESPONSE_FILE || '',
    documentFile: process.env.XLOOOP_SIGNED_CHAIN_DOCUMENT_UPLOAD_RESPONSE_FILE || '',
    accessFile: process.env.XLOOOP_SIGNED_CHAIN_DOCUMENT_ACCESS_RESPONSE_FILE || '',
    outputFile: process.env.XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_CAPTURE_FILE || '',
    actorId: process.env.XLOOOP_SIGNED_CHAIN_ACTOR_ID || '',
    workspaceId: process.env.XLOOOP_SIGNED_CHAIN_WORKSPACE_ID || '',
    apiBase: process.env.XLOOOP_PILOT_SHADOW_API_BASE || '',
  });
  const output = path.resolve(process.env.XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_CAPTURE_FILE);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(capture, null, 2)}\n`);
  console.log(JSON.stringify({
    schema_id: 'xlooop.pilot_shadow_signed_chain_capture_builder.report.v1',
    status: 'PASS',
    capture_file: output,
    chain_kinds: capture.chains.map((chain) => chain.kind),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    schema_id: 'xlooop.pilot_shadow_signed_chain_capture_builder.report.v1',
    status: 'FAIL',
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}

function buildCapture({ gmailFile, documentFile, accessFile, outputFile, actorId, workspaceId, apiBase }) {
  for (const [name, value] of Object.entries({
    XLOOOP_SIGNED_CHAIN_GMAIL_SYNC_RESPONSE_FILE: gmailFile,
    XLOOOP_SIGNED_CHAIN_DOCUMENT_UPLOAD_RESPONSE_FILE: documentFile,
    XLOOOP_SIGNED_CHAIN_DOCUMENT_ACCESS_RESPONSE_FILE: accessFile,
    XLOOOP_PILOT_SHADOW_SIGNED_CHAIN_CAPTURE_FILE: outputFile,
    XLOOOP_SIGNED_CHAIN_ACTOR_ID: actorId,
    XLOOOP_SIGNED_CHAIN_WORKSPACE_ID: workspaceId,
    XLOOOP_PILOT_SHADOW_API_BASE: apiBase,
  })) {
    if (!String(value || '').trim()) throw new Error(`${name} is required`);
  }
  if (!isPilotShadowApi(apiBase)) throw new Error('API base must be the pilot-shadow Worker, never production');

  const gmail = readResponse(gmailFile, 'gmail sync');
  const document = readResponse(documentFile, 'document upload');
  const access = readResponse(accessFile, 'document access');
  rejectRawBodyKeys({ gmail, document, access });

  const gmailSource = requireObject(gmail.source, 'gmail.source');
  const gmailSync = requireObject(gmail.sync, 'gmail.sync');
  const emitted = Array.isArray(gmailSync.emitted_events) ? gmailSync.emitted_events : [];
  const gmailEvent = requireObject(emitted[0], 'gmail.sync.emitted_events[0]');
  const gmailScopes = Array.isArray(gmailSource.scopes) ? gmailSource.scopes.map(String) : [];
  const restrictedScopeVerified = gmailScopes.some((scope) => scope === 'gmail.readonly' || scope.endsWith('/gmail.readonly'));
  if (gmailSource.provider !== 'gmail') throw new Error('gmail response provider is not gmail');
  if (gmailSource.workspace_id !== workspaceId || gmailSource.workspace_binding !== 'workspace_bound') {
    throw new Error('gmail source is not bound to the expected workspace');
  }
  if (!restrictedScopeVerified) throw new Error('gmail.readonly scope is not present in the live response');
  requireStrings(gmail, ['source_sync_receipt_id', 'operation_event_id', 'audit_event_id', 'projection_outbox_id'], 'gmail');
  requireStrings(gmailEvent, ['source_event_id', 'operation_event_id', 'source_ref_hash'], 'gmail event');
  if (!/^[0-9a-f]{64}$/.test(gmailEvent.source_ref_hash)) throw new Error('gmail source_ref_hash is invalid');

  const documentMeta = requireObject(document.document, 'document.document');
  if (documentMeta.workspace_id !== workspaceId) throw new Error('document is not bound to the expected workspace');
  requireStrings(document, ['receipt_id', 'operation_event_id', 'audit_event_id', 'projection_outbox_id'], 'document');
  requireStrings(documentMeta, ['id', 'content_hash'], 'document metadata');
  if (!/^[0-9a-f]{64}$/.test(documentMeta.content_hash)) throw new Error('document content_hash is invalid');
  if (!Number.isInteger(Number(documentMeta.version)) || Number(documentMeta.version) < 1) {
    throw new Error('document version is invalid');
  }

  const entries = Array.isArray(access.entries) ? access.entries : [];
  const accessRow = entries.find((entry) =>
    entry &&
    entry.document_id === documentMeta.id &&
    entry.user_id === actorId &&
    typeof entry.document_access_log_id === 'string' &&
    entry.document_access_log_id.length > 0
  );
  if (!accessRow) throw new Error('matching document access audit row is absent');

  return {
    schema_id: 'xlooop.pilot_shadow_signed_chain_capture.v1',
    environment: 'pilot-shadow',
    authority: 'shadow',
    api_base: apiBase,
    nonproduction_origin_verified: true,
    authenticated_session_verified: true,
    chains: [
      {
        kind: 'gmail',
        provider: 'gmail',
        workspace_id: workspaceId,
        actor_id: actorId,
        source_connection_id: String(gmailSource.id),
        source_event_id: gmailEvent.source_event_id,
        message_ref_hash: gmailEvent.source_ref_hash,
        receipt_id: gmail.source_sync_receipt_id,
        operation_event_id: gmail.operation_event_id,
        audit_event_id: gmail.audit_event_id,
        workspace_binding_verified: true,
        restricted_scope_verified: true,
      },
      {
        kind: 'document',
        workspace_id: workspaceId,
        actor_id: actorId,
        document_id: documentMeta.id,
        content_hash: documentMeta.content_hash,
        version: Number(documentMeta.version),
        document_access_log_id: accessRow.document_access_log_id,
        receipt_id: document.receipt_id,
        operation_event_id: document.operation_event_id,
        audit_event_id: document.audit_event_id,
        workspace_binding_verified: true,
        content_hash_verified: true,
      },
    ],
  };
}

function readResponse(file, label) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`${label} response file not found: ${resolved}`);
  const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} response is not an object`);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is required`);
  return value;
}

function requireStrings(value, fields, label) {
  for (const field of fields) {
    if (typeof value[field] !== 'string' || !value[field].trim()) throw new Error(`${label}.${field} is required`);
  }
}

function rejectRawBodyKeys(value, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (/(^|_)(body|raw_body|message_body|document_body|mail_body|email_body|content_text|extracted_text|content_base64)$/i.test(key)) {
      throw new Error(`raw content key is forbidden in response capture: ${current}`);
    }
    rejectRawBodyKeys(child, current);
  }
}

function isPilotShadowApi(apiBase) {
  return typeof apiBase === 'string' &&
    /^https:\/\//.test(apiBase) &&
    apiBase !== 'https://api.xlooop.com' &&
    /xlooop-api-pilot-shadow/.test(apiBase);
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlooop-chain-capture-'));
  const gmailFile = path.join(tmp, 'gmail.json');
  const documentFile = path.join(tmp, 'document.json');
  const accessFile = path.join(tmp, 'access.json');
  const outputFile = path.join(tmp, 'capture.json');
  const hash = 'a'.repeat(64);
  fs.writeFileSync(gmailFile, JSON.stringify({
    source: {
      id: 'src_gmail_1',
      workspace_id: 'ws_1',
      workspace_binding: 'workspace_bound',
      provider: 'gmail',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    },
    sync: {
      emitted_events: [{
        source_event_id: `gmail:${hash}`,
        operation_event_id: 'evt_gmail_1',
        source_ref_hash: hash,
      }],
    },
    source_sync_receipt_id: 'source-sync:src_gmail_1:success:audit_sync_1',
    operation_event_id: 'evt_sync_1',
    audit_event_id: 'audit_sync_1',
    projection_outbox_id: 'outbox_sync_1',
  }));
  fs.writeFileSync(documentFile, JSON.stringify({
    document: { id: 'doc_1', workspace_id: 'ws_1', content_hash: hash, version: 1 },
    receipt_id: 'document-upload:doc_1:audit_doc_1',
    operation_event_id: 'evt_doc_1',
    audit_event_id: 'audit_doc_1',
    projection_outbox_id: 'outbox_doc_1',
  }));
  fs.writeFileSync(accessFile, JSON.stringify({
    entries: [{
      document_access_log_id: 'document-access:ws_1:doc_1:usr_1:2026-07-26',
      document_id: 'doc_1',
      user_id: 'usr_1',
    }],
  }));
  const capture = buildCapture({
    gmailFile,
    documentFile,
    accessFile,
    outputFile,
    actorId: 'usr_1',
    workspaceId: 'ws_1',
    apiBase: 'https://xlooop-api-pilot-shadow.xlooop23.workers.dev',
  });
  if (capture.chains.length !== 2 || capture.chains[0].message_ref_hash !== hash || capture.chains[1].document_id !== 'doc_1') {
    throw new Error('self-test failed');
  }
  let rawRejected = false;
  fs.writeFileSync(documentFile, JSON.stringify({ document: { ...capture.chains[1], extracted_text: 'forbidden' } }));
  try {
    buildCapture({
      gmailFile,
      documentFile,
      accessFile,
      outputFile,
      actorId: 'usr_1',
      workspaceId: 'ws_1',
      apiBase: 'https://xlooop-api-pilot-shadow.xlooop23.workers.dev',
    });
  } catch {
    rawRejected = true;
  }
  if (!rawRejected) throw new Error('self-test did not reject raw content');
  console.log('PASS pilot-shadow signed-chain response capture self-test');
}
