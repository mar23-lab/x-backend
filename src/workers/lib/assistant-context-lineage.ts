import type { Sql } from '../db/client';
import { buildContextPacket, type ContextScopeCounts } from './context-packet';
import { catalogBindingsIfEnabled, CATALOG_MANIFEST_SHA256 } from './role-skill-catalog-loader';
import { resolveRoleAndSkills, type RoleSkillResolution } from './role-skill-resolver';
import { insertContextPacketRow, sealContextPacket } from '../dal/context-packet-store';
import {
  insertRoleSkillResolutionRow,
  insertSkillInvocationReceiptRow,
  resolutionSigningPayload,
  signReceipt,
  skillInvocationSigningPayload,
} from '../dal/role-skill-resolution-store';

export interface AssistantContextLineageEnv {
  ROLE_SKILL_CATALOG_ENABLED?: string;
  RESOLUTION_RECEIPT_SIGNING_SECRET?: string;
  RESOLUTION_RECEIPT_SIGNING_KEY_ID?: string;
  XLOOOP_DEPLOY_SHA?: string;
}

export interface AssistantContextLineageInput {
  workspace_id: string;
  principal_id: string;
  role: string;
  mode: string;
  intent_ref: string;
  scope: ContextScopeCounts;
  redaction_profile: string;
  client_empty: boolean;
}

export interface AssistantContextLineage {
  context_packet_id: string;
  resolution_id: string;
  action: 'assistant:answer' | 'assistant:plan';
  resolution: RoleSkillResolution;
}

export async function persistAssistantContextLineage(
  sql: Sql,
  env: AssistantContextLineageEnv,
  input: AssistantContextLineageInput,
  now = new Date(),
): Promise<AssistantContextLineage> {
  const catalog = catalogBindingsIfEnabled(env);
  if (!catalog) throw new Error('role-skill catalog is not enabled');
  const action = input.mode === 'plan' ? 'assistant:plan' : 'assistant:answer';
  const resolution = resolveRoleAndSkills({
    tenant: input.workspace_id,
    principal: input.principal_id,
    role: input.role,
    mode: input.mode,
    action,
    intent: input.intent_ref,
    entitlementActive: true,
    tenantMismatch: false,
    requiresOperatorMode: false,
  }, catalog.bindings, now);
  if (!resolution.verdict.allowed || resolution.skill_coverage !== 'resolved') {
    throw new Error(`assistant capability unresolved: ${resolution.verdict.reason}`);
  }

  const issued_at = now.toISOString();
  const resolutionReceipt = await signReceipt(
    env.RESOLUTION_RECEIPT_SIGNING_SECRET,
    resolutionSigningPayload(resolution, {
      workspace_id: input.workspace_id,
      principal_id: input.principal_id,
      actual_reason: 'resolved',
      actual_allowed: true,
      issued_at,
      resolver_source: 'catalog',
      deploy_sha: env.XLOOOP_DEPLOY_SHA ?? null,
    }),
    env.RESOLUTION_RECEIPT_SIGNING_KEY_ID,
  );
  const resolution_id = await insertRoleSkillResolutionRow(sql, {
    workspace_id: input.workspace_id,
    principal_id: input.principal_id,
    action,
    mode: input.mode,
    intent_ref: input.intent_ref,
    resolution,
    actual_reason: 'resolved',
    actual_allowed: true,
    agreement: 'agree',
    receipt: resolutionReceipt,
    resolver_source: 'catalog',
    deploy_sha: env.XLOOOP_DEPLOY_SHA ?? null,
    catalog_manifest_sha256: CATALOG_MANIFEST_SHA256,
  });
  const packet = buildContextPacket({
    tenant: input.workspace_id,
    principal: input.principal_id,
    role: input.role,
    mode: input.mode,
    intent: input.intent_ref,
    resolution,
    scope: input.scope,
    redaction_profile: input.redaction_profile,
    client_empty: input.client_empty,
    receipt_ref: resolution_id,
  }, now);
  const packetReceipt = await sealContextPacket(
    env.RESOLUTION_RECEIPT_SIGNING_SECRET,
    packet,
    env.RESOLUTION_RECEIPT_SIGNING_KEY_ID,
  );
  const context_packet_id = await insertContextPacketRow(sql, packet, packetReceipt);
  return { context_packet_id, resolution_id, action, resolution };
}

export async function completeAssistantSkillLineage(
  sql: Sql,
  env: AssistantContextLineageEnv,
  lineage: AssistantContextLineage,
  input: Pick<AssistantContextLineageInput, 'workspace_id' | 'principal_id'>,
  now = new Date(),
): Promise<string[]> {
  const ids: string[] = [];
  for (const skill of lineage.resolution.selected_skills) {
    const issued_at = now.toISOString();
    const payload = skillInvocationSigningPayload({
      workspace_id: input.workspace_id,
      principal_id: input.principal_id,
      resolution_id: lineage.resolution_id,
      skill_key: skill.key,
      skill_version: skill.version,
      action: lineage.action,
      status: 'completed',
      evidence_ref_ids: [],
      issued_at,
    });
    const receipt = await signReceipt(env.RESOLUTION_RECEIPT_SIGNING_SECRET, payload, env.RESOLUTION_RECEIPT_SIGNING_KEY_ID);
    ids.push(await insertSkillInvocationReceiptRow(sql, {
      workspace_id: input.workspace_id,
      resolution_id: lineage.resolution_id,
      principal_id: input.principal_id,
      skill_key: skill.key,
      skill_version: skill.version,
      action: lineage.action,
      status: 'completed',
      evidence_ref_ids: [],
      receipt,
    }));
  }
  return ids;
}
