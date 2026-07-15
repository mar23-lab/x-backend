// context-packet-store.ts · AR-2.4 / ABS-P4 (260713) · DAL for the context-assembly evidence plane (mig-071).
//
// Persists the pure ContextPacket kernel (lib/context-packet.ts) into context_packets. House store pattern
// (dal/role-skill-resolution-store.ts): free `...Row` fn, first param `sql: Sql`, tagged-template
// parameterized INSERT, degrade-safe (the assembler wraps the write in waitUntil + try/catch so a write
// error can never break the governed-action path). Assistant execution calls this only when
// CONTEXT_PACKET_PERSISTENCE_ENABLED is true (the packet is customer-safe and only writes counts,
// coarse capability labels, a FNV fingerprint, and an integrity hash — never ids/graph/prompt/skill body).

import type { Sql } from '../db/client';
import type { ContextPacket } from '../lib/context-packet';
import { signReceipt, type SignedReceipt } from './role-skill-resolution-store';

/** Canonical, order-fixed payload for a context-packet integrity hash (reproducible; sign only when a
 *  secret is configured — see signReceipt). Excludes generated_at + receipt_ref so the same context+policy
 *  hashes identically across requests, mirroring the kernel's context_fingerprint. Customer-safe surface. */
export function contextPacketSigningPayload(p: ContextPacket): string {
  return JSON.stringify({
    schema_id: 'xlooop.context_packet_signature_payload.v1',
    tenant: p.tenant,
    role: p.role,
    mode: p.mode,
    intent: p.intent ?? '',
    selected_skills: p.selected_skills.map((s) => `${s.key}@${s.version}`).sort(),
    allowed_tools: p.allowed_tools.slice().sort(),
    denied_tools: p.denied_tools.slice().sort(),
    context_scope: p.context_scope,
    redaction: p.redaction,
    skill_coverage: p.skill_coverage,
    context_fingerprint: p.context_fingerprint,
  });
}

/** Convenience: hash (+ optionally sign) the packet, ready to pass to insertContextPacketRow. Never throws
 *  (signReceipt degrades to hashed-but-unsigned). */
export async function sealContextPacket(secret: string | undefined, packet: ContextPacket, keyId?: string): Promise<SignedReceipt> {
  return signReceipt(secret, contextPacketSigningPayload(packet), keyId);
}

/** Persist one context packet + its integrity receipt. Column set matches mig-071 exactly. */
export async function insertContextPacketRow(sql: Sql, packet: ContextPacket, receipt: SignedReceipt): Promise<string> {
  const id = `cpk_${crypto.randomUUID()}`;
  const s = packet.context_scope;
  await sql/*sql*/`
    INSERT INTO context_packets (
      id, workspace_id, principal_id, role_key, mode, intent_ref,
      selected_skills, allowed_tools, denied_tools, skill_coverage,
      event_count, document_count, unpromoted_document_count, source_count,
      redaction_profile, client_empty, policy_summary, context_fingerprint,
      content_sha256, signature_alg, signature, receipt_ref, stale_after_s, generated_at
    ) VALUES (
      ${id}, ${packet.tenant}, ${packet.principal}, ${packet.role}, ${packet.mode}, ${packet.intent},
      ${JSON.stringify(packet.selected_skills)}::jsonb, ${packet.allowed_tools}, ${packet.denied_tools}, ${packet.skill_coverage},
      ${s.event_count}, ${s.document_count}, ${s.unpromoted_document_count}, ${s.source_count},
      ${packet.redaction.profile}, ${packet.redaction.client_empty}, ${packet.policy_summary}, ${packet.context_fingerprint},
      ${receipt.content_sha256}, ${receipt.signature_alg}, ${receipt.signature}, ${packet.receipt_ref},
      ${packet.freshness.stale_after_s}, ${packet.freshness.generated_at}
    )
  `;
  return id;
}
