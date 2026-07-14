#!/usr/bin/env node
// verify-model-runtime-secret-safety.mjs · Wave C (260708) · the encryption-at-rest guardrail for customer
// model-provider credentials. Cloudflare Workers have no per-tenant vault, so provider keys are encrypted at
// rest in Postgres. This gate freezes the properties that keep a customer key from ever leaking:
//
//   T1 · SCHEMA — migration 053 stores ONLY sealed columns (credential_ciphertext/_iv/_last4); it must NOT
//        declare a plaintext credential column (api_key / api_secret / a bare `credential TEXT`).
//   T2 · NO-LEAK — no read path serializes the sealed material: the store's list SELECT + the route file
//        must not reference credential_ciphertext / credential_iv (only the masked last4 leaves the server).
//   T3 · AUDITED — the workspace-default flip writes an audit_logs row (model_runtime_default_change).
//   T4 · CRYPTO — the crypto lib uses AES-GCM with a per-encryption random IV (getRandomValues) and fails
//        CLOSED on a missing/short master key (throws; never stores plaintext).
//
// Adversarial: add a plaintext key column, select the ciphertext in a read, drop the flip audit, swap the
// random IV for a constant, or make the key optional → FAIL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = 'src/workers/db/migrations/053_model_runtimes.sql';
const STORE = 'src/workers/dal/model-runtime-store.ts';
const ROUTE = 'src/workers/routes/model-runtimes.ts';
const CRYPTO = 'src/workers/lib/model-runtime-crypto.ts';
const fail = [];
const read = (rel) => { const p = path.join(ROOT, rel); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };

// ── T1 · SCHEMA — sealed columns only, no plaintext credential column ─────────
const mig = read(MIGRATION);
if (!mig) { fail.push(`${MIGRATION} · missing`); }
else {
  for (const col of ['credential_ciphertext', 'credential_iv', 'credential_last4']) {
    if (!new RegExp(`\\b${col}\\b`).test(mig)) fail.push(`${MIGRATION} · missing the sealed column '${col}'`);
  }
  // A plaintext credential column is a hard leak. Flag a column DECLARATION named like a plaintext secret.
  // (credential_ciphertext/_iv/_last4 are fine — the word boundary + trailing type keeps them clear.)
  const plaintextCol = mig.match(/^\s*(api_key|api_secret|secret_key|access_key|credential|plaintext_key|apikey)\s+(TEXT|VARCHAR|JSONB)/im);
  if (plaintextCol) fail.push(`${MIGRATION} · declares a PLAINTEXT credential column '${plaintextCol[1]}' — provider keys must be sealed (ciphertext/iv/last4) only`);
}

// ── T2 · NO-LEAK — no read path references the sealed material ─────────────────
const store = read(STORE);
if (!store) { fail.push(`${STORE} · missing`); }
else {
  // The list read must not select the ciphertext/iv. Isolate listProvidersRow and assert it is masked.
  const listFn = store.match(/export async function listProvidersRow[\s\S]*?\n}/);
  const listBody = listFn ? listFn[0] : store;
  if (/credential_ciphertext|credential_iv/.test(listBody)) {
    fail.push(`${STORE} · listProvidersRow selects credential_ciphertext/_iv — the list read must be masked (last4 only)`);
  }
  // The ciphertext may be read in EXACTLY ONE place: getProviderCredentialRow (the internal decrypt path).
  const cipherRefs = (store.match(/credential_ciphertext/g) || []).length;
  const inGetCred = /getProviderCredentialRow[\s\S]*?credential_ciphertext/.test(store);
  if (cipherRefs > 0 && !inGetCred) {
    fail.push(`${STORE} · credential_ciphertext is referenced outside getProviderCredentialRow — the only ciphertext read must be the internal decrypt path`);
  }
}
const route = read(ROUTE);
if (!route) { fail.push(`${ROUTE} · missing`); }
else if (/credential_ciphertext|credential_iv/.test(route)) {
  // The route must never touch the sealed columns — it deals in the masked view + the crypto lib only.
  fail.push(`${ROUTE} · references credential_ciphertext/_iv — the route must never handle the sealed columns (mask via renderMaskedCredential)`);
}

// ── T3 · AUDITED — the default flip writes an audit_logs row ───────────────────
if (store) {
  const flipFn = store.match(/export async function setDefaultProviderRow[\s\S]*?\n}/);
  const flipBody = flipFn ? flipFn[0] : '';
  if (!/INSERT INTO audit_logs/.test(flipBody) && !/auditRow\(/.test(flipBody)) {
    fail.push(`${STORE} · setDefaultProviderRow no longer writes an audit_logs row — the governed default flip must be audited`);
  }
  if (!/model_runtime_default_change/.test(flipBody)) {
    fail.push(`${STORE} · setDefaultProviderRow no longer uses the 'model_runtime_default_change' audit action`);
  }
}

// ── T4 · CRYPTO — AES-GCM + random IV + fail-closed ───────────────────────────
const crypto = read(CRYPTO);
if (!crypto) { fail.push(`${CRYPTO} · missing`); }
else {
  if (!/AES-GCM/.test(crypto)) fail.push(`${CRYPTO} · not using AES-GCM`);
  if (!/getRandomValues\(new Uint8Array\(IV_BYTES\)\)|getRandomValues\([^)]*IV/.test(crypto)) {
    fail.push(`${CRYPTO} · the IV is not a per-encryption random value (getRandomValues) — GCM is broken by IV reuse`);
  }
  // fail-closed: importMasterKey throws when the key is absent or the wrong length.
  const importFn = crypto.match(/function importMasterKey[\s\S]*?\n}/);
  const importBody = importFn ? importFn[0] : '';
  if (!/throw new Error/.test(importBody) || !/KEY_BYTES/.test(importBody)) {
    fail.push(`${CRYPTO} · importMasterKey no longer fails closed on a missing/short master key (must throw, never store plaintext)`);
  }
}

// ── T5 · SERVER-DERIVED AUTHORITY — the GET serves the allowed_actions envelope, not a client-computed
// boolean (the GAP-004 class: authority must be server-derived, never re-derived in the frontend). ───────
if (route) {
  if (!/withAuthority\([^)]*'model_runtime'/.test(route)) {
    fail.push(`${ROUTE} · GET /model-runtimes/providers no longer serves the withAuthority('model_runtime') envelope — authority must be server-derived (allowed_actions/disabled_reasons), not a bare client-computed boolean`);
  }
  if (/\bmanageable:\s*isOperatorContext/.test(route)) {
    fail.push(`${ROUTE} · re-introduced the bare 'manageable' authority boolean — use the withAuthority envelope instead (allowed_actions is the contract)`);
  }
}

if (fail.length) {
  console.error('✗ model-runtime-secret-safety · FAIL — a customer-credential leak guardrail regressed:');
  for (const v of fail) console.error(`    ${v}`);
  process.exit(1);
}
console.log('☑ model-runtime-secret-safety · PASS · sealed-only schema · masked reads · audited default flip · AES-GCM random-IV fail-closed crypto');
process.exit(0);
