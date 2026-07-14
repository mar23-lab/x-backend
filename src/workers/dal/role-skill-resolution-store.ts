// role-skill-resolution-store.ts · OAR-W2 (260713) · DAL for the role/skill evidence plane (mig-070).
//
// Mirrors the house store pattern (dal/feedback-store.ts, dal/entitlement-store.ts): free `...Row`
// functions, first param `sql: Sql`, tagged-template parameterized INSERT, degrade-safe (the WRITE
// surfaces nothing to the caller — the shadow observer wraps it in waitUntil + try/catch so a write
// error can never break the governed-write path).
//
// Receipt integrity: HS256 over a canonical payload, reusing the mcp-gateway packet-signing pattern
// (crypto.subtle HMAC-SHA-256 → base64url). When RESOLUTION_RECEIPT_SIGNING_SECRET is unset the row is
// written UNSIGNED (signature_alg='none') — honest: a shadow observer must never 503, and the claim is
// "platform-issued integrity when configured", not non-repudiation.

import type { Sql } from '../db/client';
import type { RoleSkillResolution } from '../lib/role-skill-resolver';

// ── signing (HS256, mcp-gateway.ts:180-196 pattern) ────────────────────────────────────────────────
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function sha256Hex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SignedReceipt {
  content_sha256: string;
  signature_alg: 'none' | 'HS256';
  signature: string | null;
  signing_key_id: string | null;
}

/** Hash the canonical payload always; sign only when a secret is configured. Never throws. */
export async function signReceipt(secret: string | undefined, payload: string, keyId?: string): Promise<SignedReceipt> {
  const content_sha256 = await sha256Hex(payload);
  if (!secret) {
    return { content_sha256, signature_alg: 'none', signature: null, signing_key_id: null };
  }
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return { content_sha256, signature_alg: 'HS256', signature: base64Url(new Uint8Array(sig)), signing_key_id: keyId ?? 'default' };
  } catch {
    // signing must never break the shadow path; fall back to hashed-but-unsigned
    return { content_sha256, signature_alg: 'none', signature: null, signing_key_id: null };
  }
}

/** Canonical, stable JSON for the resolution receipt (order-fixed so the hash is reproducible).
 *  Provenance fields (resolver_source/deploy_sha) added by the activation-readiness review 260713 —
 *  still schema v1: the v1 payload had never been emitted anywhere (flag off, table applied nowhere),
 *  so this is a pre-release amendment, not a contract break. */
export function resolutionSigningPayload(
  r: RoleSkillResolution,
  ctx: {
    workspace_id: string;
    principal_id: string;
    actual_reason: string;
    actual_allowed: boolean;
    issued_at: string;
    resolver_source: string;
    deploy_sha: string | null;
  },
): string {
  return JSON.stringify({
    schema_id: 'xlooop.role_skill_resolution_signature_payload.v1',
    workspace_id: ctx.workspace_id,
    principal_id: ctx.principal_id,
    role: r.selected_role,
    action_family: r.safe_explanation, // safe surface only in the signed payload
    selected_skills: r.selected_skills,
    skill_coverage: r.skill_coverage,
    resolver_verdict: r.verdict.reason,
    resolver_allowed: r.verdict.allowed,
    actual_reason: ctx.actual_reason,
    actual_allowed: ctx.actual_allowed,
    resolver_source: ctx.resolver_source,
    deploy_sha: ctx.deploy_sha,
    expires_at: r.expires_at,
    issued_at: ctx.issued_at,
  });
}

// ── row inputs ─────────────────────────────────────────────────────────────────────────────────────
export type Agreement = 'agree' | 'resolver_stricter' | 'resolver_looser';

export interface ResolutionRowInput {
  workspace_id: string;
  principal_id: string;
  action: string;
  mode: string;
  intent_ref: string | null;
  resolution: RoleSkillResolution;
  actual_reason: string;
  actual_allowed: boolean;
  agreement: Agreement;
  receipt: SignedReceipt;
  /** provenance (260713): which binding source produced this resolution */
  resolver_source: 'v0-floor' | 'catalog' | 'mixed';
  /** build SHA of the observing Worker (env XLOOOP_DEPLOY_SHA; null when unstamped) */
  deploy_sha: string | null;
  /** sha256 of the published catalog manifest the bindings came from (null on the v0 floor) */
  catalog_manifest_sha256: string | null;
}

export interface DenialRowInput {
  workspace_id: string;
  principal_id: string;
  role_key: string;
  action: string;
  mode: string;
  denied_by: 'entitlement' | 'resolver' | 'both';
  entitlement_reason: string | null;
  resolver_reason: string | null;
  safe_explanation: string;
  receipt: SignedReceipt;
}

// ── writes (degrade-safe: throw is swallowed by the observer's waitUntil wrapper) ───────────────────
export async function insertRoleSkillResolutionRow(sql: Sql, input: ResolutionRowInput): Promise<void> {
  const id = `rsr_${crypto.randomUUID()}`;
  const r = input.resolution;
  await sql/*sql*/`
    INSERT INTO role_skill_resolutions (
      id, workspace_id, principal_id, role_key, role_version, action, mode, intent_ref,
      selected_skills, allowed_tools, denied_tools, required_approvals, skill_coverage,
      resolver_verdict, resolver_allowed, actual_reason, actual_allowed, agreement,
      content_sha256, signature_alg, signature, signing_key_id,
      resolver_source, deploy_sha, catalog_manifest_sha256, expires_at
    ) VALUES (
      ${id}, ${input.workspace_id}, ${input.principal_id}, ${r.selected_role}, ${r.selected_role_version},
      ${input.action}, ${input.mode}, ${input.intent_ref},
      ${JSON.stringify(r.selected_skills)}::jsonb, ${r.allowed_tools}, ${r.denied_tools}, ${r.required_approvals},
      ${r.skill_coverage}, ${r.verdict.reason}, ${r.verdict.allowed}, ${input.actual_reason}, ${input.actual_allowed},
      ${input.agreement}, ${input.receipt.content_sha256}, ${input.receipt.signature_alg},
      ${input.receipt.signature}, ${input.receipt.signing_key_id},
      ${input.resolver_source}, ${input.deploy_sha}, ${input.catalog_manifest_sha256}, ${r.expires_at}
    )
  `;
}

export async function insertAuthorityDenialRow(sql: Sql, input: DenialRowInput): Promise<void> {
  const id = `adr_${crypto.randomUUID()}`;
  await sql/*sql*/`
    INSERT INTO authority_denial_receipts (
      id, workspace_id, principal_id, role_key, action, mode, denied_by,
      entitlement_reason, resolver_reason, safe_explanation,
      content_sha256, signature_alg, signature, signing_key_id
    ) VALUES (
      ${id}, ${input.workspace_id}, ${input.principal_id}, ${input.role_key}, ${input.action}, ${input.mode},
      ${input.denied_by}, ${input.entitlement_reason}, ${input.resolver_reason}, ${input.safe_explanation},
      ${input.receipt.content_sha256}, ${input.receipt.signature_alg}, ${input.receipt.signature}, ${input.receipt.signing_key_id}
    )
  `;
}

// ── closed-loop evidence writers (AR-2.3 / OAR-W6, 260713) ───────────────────────────────────────────
// The mig-070 tables skill_invocation_receipts + closing_attestations ship empty in W2 ("reserved for the
// closed loop"). These are the writers the closed loop (intent → resolution → INVOCATION → evidence →
// sign-off → CLOSING) inserts through. They land NOW, INERT: no INSERT site is wired into a live flow yet
// (that closed-loop wiring is a separate operator-gated flow-design step). Same house pattern + optional
// HS256 receipt as the resolution/denial writers above. NB: neither table has a signing_key_id column
// (unlike role_skill_resolutions), so the receipt's key id is intentionally not persisted here.

export type SkillInvocationStatus = 'invoked' | 'completed' | 'failed' | 'denied';

/** Canonical, order-fixed payload for a skill-invocation receipt (reproducible hash; sign only when a
 *  secret is configured — see signReceipt). Carries only linkage + status, no raw skill body/prompt. */
export function skillInvocationSigningPayload(ctx: {
  workspace_id: string;
  principal_id: string;
  resolution_id: string | null;
  skill_key: string;
  skill_version: string;
  action: string;
  status: SkillInvocationStatus;
  evidence_ref_ids: string[];
  issued_at: string;
}): string {
  return JSON.stringify({
    schema_id: 'xlooop.skill_invocation_receipt_signature_payload.v1',
    workspace_id: ctx.workspace_id,
    principal_id: ctx.principal_id,
    resolution_id: ctx.resolution_id,
    skill_key: ctx.skill_key,
    skill_version: ctx.skill_version,
    action: ctx.action,
    status: ctx.status,
    evidence_ref_ids: ctx.evidence_ref_ids,
    issued_at: ctx.issued_at,
  });
}

export interface SkillInvocationReceiptInput {
  workspace_id: string;
  /** the resolution row this invocation ran under; NULL-safe (FK is ON DELETE SET NULL) */
  resolution_id: string | null;
  principal_id: string;
  skill_key: string;
  skill_version: string;
  action: string;
  status: SkillInvocationStatus;
  evidence_ref_ids: string[];
  receipt: SignedReceipt;
}

export async function insertSkillInvocationReceiptRow(sql: Sql, input: SkillInvocationReceiptInput): Promise<void> {
  const id = `sir_${crypto.randomUUID()}`;
  await sql/*sql*/`
    INSERT INTO skill_invocation_receipts (
      id, workspace_id, resolution_id, principal_id, skill_key, skill_version, action, status,
      evidence_ref_ids, content_sha256, signature_alg, signature
    ) VALUES (
      ${id}, ${input.workspace_id}, ${input.resolution_id}, ${input.principal_id},
      ${input.skill_key}, ${input.skill_version}, ${input.action}, ${input.status},
      ${input.evidence_ref_ids}, ${input.receipt.content_sha256}, ${input.receipt.signature_alg}, ${input.receipt.signature}
    )
  `;
}

export type ClosingOutcome = 'attested' | 'skipped' | 'failed';

/** Canonical, order-fixed payload for a closing attestation (ports MB-P closing_skills: one row per
 *  session/wave closeout). Customer-safe fields only — no internal engine names or agent chains. */
export function closingAttestationSigningPayload(ctx: {
  workspace_id: string;
  principal_id: string;
  correlation_id: string | null;
  role_key: string;
  closing_skill: string;
  outcome: ClosingOutcome;
  evidence_ref_ids: string[];
  issued_at: string;
}): string {
  return JSON.stringify({
    schema_id: 'xlooop.closing_attestation_signature_payload.v1',
    workspace_id: ctx.workspace_id,
    principal_id: ctx.principal_id,
    correlation_id: ctx.correlation_id,
    role_key: ctx.role_key,
    closing_skill: ctx.closing_skill,
    outcome: ctx.outcome,
    evidence_ref_ids: ctx.evidence_ref_ids,
    issued_at: ctx.issued_at,
  });
}

export interface ClosingAttestationInput {
  workspace_id: string;
  principal_id: string;
  /** links the attestation to a run/wave; nullable */
  correlation_id: string | null;
  role_key: string;
  closing_skill: string;
  outcome: ClosingOutcome;
  evidence_ref_ids: string[];
  receipt: SignedReceipt;
}

export async function insertClosingAttestationRow(sql: Sql, input: ClosingAttestationInput): Promise<void> {
  const id = `cla_${crypto.randomUUID()}`;
  await sql/*sql*/`
    INSERT INTO closing_attestations (
      id, workspace_id, principal_id, correlation_id, role_key, closing_skill, outcome,
      evidence_ref_ids, content_sha256, signature_alg, signature
    ) VALUES (
      ${id}, ${input.workspace_id}, ${input.principal_id}, ${input.correlation_id},
      ${input.role_key}, ${input.closing_skill}, ${input.outcome},
      ${input.evidence_ref_ids}, ${input.receipt.content_sha256}, ${input.receipt.signature_alg}, ${input.receipt.signature}
    )
  `;
}
