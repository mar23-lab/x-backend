// template-policy-store.ts · tenant-scoped effective template/policy projection store.
//
// Customer APIs resolve approved, redacted effective templates only. They do not
// expose MB-P raw governance files, private graph schema, scoring templates,
// agent routing, secrets, or broad memory search.

import { assertWorkspaceScope } from './DalAdapter';
import { makeError, randomNanoid } from './shared-helpers';
import { withWorkspaceRlsContext } from './operational-spine-store';
import type { Sql } from '../db/client';
import type {
  EffectiveTemplateEnvelope,
  EffectiveTemplateSnapshot,
  EffectivePersonalizationProfile,
  TemplateAdminApproval,
  TemplateAdminApprovalInput,
  TemplateBindingScope,
  TemplatePolicyListOpts,
  TenantLearningPromotion,
  TenantLearningPromotionInput,
  UserLearningSignal,
  UserLearningSignalInput,
  UserId,
  WorkspaceId,
} from './types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const INHERITANCE_ORDER = [
  'global platform default',
  'vertical pack',
  'company tenant binding',
  'workspace/project binding',
  'user overlay personalization',
] as const;

const FORBIDDEN_OVERRIDE_KEYS = [
  'security',
  'retention',
  'approval',
  'redaction',
  'forbidden_surfaces',
  'tenant_isolation',
  'raw_graph',
  'full_tenant_memory',
  'governance_scoring',
  'agent_routing',
  'private_graph_schema',
  'secrets',
  'search_all_memory',
] as const;

type TemplateProjectionRow = {
  template_id: string;
  template_key: string;
  name: string;
  category: string;
  binding_scope: TemplateBindingScope;
  version_id: string;
  version: string;
  content_sha256: string;
  redacted_content: Record<string, unknown>;
  source_ref: string;
  source_sha: string;
  approval_ref: string;
  lifecycle_state: EffectiveTemplateEnvelope['lifecycle_state'];
  overlay_json: Record<string, unknown> | null;
  updated_at: string;
};

type UserPersonalizationProfileRow = {
  preference_json: Record<string, unknown> | null;
  personal_rules_json: Record<string, unknown> | null;
  personal_skills_json: Record<string, unknown> | null;
  learned_defaults_json: Record<string, unknown> | null;
  source_signal_ids: string[] | null;
};

type TenantLearningProfileRow = {
  shared_rules_json: Record<string, unknown> | null;
  shared_skills_json: Record<string, unknown> | null;
  shared_defaults_json: Record<string, unknown> | null;
  source_signal_ids: string[] | null;
  approval_ref: string;
};

function limitFor(raw?: number): number {
  return Math.max(1, Math.min(raw || DEFAULT_LIMIT, MAX_LIMIT));
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function scopeRank(scope: TemplateBindingScope): number {
  switch (scope) {
    case 'global': return 1;
    case 'vertical': return 2;
    case 'tenant': return 3;
    case 'workspace': return 4;
    case 'project': return 4;
    default: return 0;
  }
}

function sortLayerRows(a: TemplateProjectionRow, b: TemplateProjectionRow): number {
  const rankDelta = scopeRank(a.binding_scope) - scopeRank(b.binding_scope);
  if (rankDelta !== 0) return rankDelta;
  return Date.parse(a.updated_at) - Date.parse(b.updated_at);
}

function applyAllowedOverlay(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): { effective: Record<string, unknown>; overlayApplied: boolean } {
  const effective = { ...base };
  let overlayApplied = false;
  for (const [key, value] of Object.entries(overlay)) {
    if ((FORBIDDEN_OVERRIDE_KEYS as readonly string[]).includes(key)) continue;
    effective[key] = value;
    overlayApplied = true;
  }
  return { effective, overlayApplied };
}

function findForbiddenOverridePath(value: unknown, prefix = ''): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findForbiddenOverridePath(value[index], `${prefix}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if ((FORBIDDEN_OVERRIDE_KEYS as readonly string[]).includes(key)) return path;
    const nested = findForbiddenOverridePath(nestedValue, path);
    if (nested) return nested;
  }
  return null;
}

function requireAllowedLearningPayload(name: string, value: unknown): Record<string, unknown> {
  const payload = jsonObject(value);
  const forbiddenPath = findForbiddenOverridePath(payload);
  if (forbiddenPath) {
    throw makeError('VALIDATION_ERROR', `${name} contains forbidden governance override key: ${forbiddenPath}`, 400);
  }
  return payload;
}

function mergeLayeredTemplateRows(rows: TemplateProjectionRow[]): {
  strongest: TemplateProjectionRow;
  effective: Record<string, unknown>;
  overlayApplied: boolean;
  sourceVersionIds: string[];
  sourceRefs: string[];
  approvalRefs: string[];
  bindingScopesApplied: string[];
} {
  const layeredRowsByTemplate = [...rows].sort(sortLayerRows);
  const [baseRow] = layeredRowsByTemplate;
  if (!baseRow) throw makeError('VALIDATION_ERROR', 'template rows required for layered resolution', 500);

  let effective = jsonObject(baseRow.redacted_content);
  let overlayApplied = false;
  const sourceVersionIds: string[] = [];
  const sourceRefs: string[] = [];
  const approvalRefs: string[] = [];
  const bindingScopesApplied: string[] = [];

  for (const row of layeredRowsByTemplate) {
    if (row !== baseRow) {
      const merged = applyAllowedOverlay(effective, jsonObject(row.redacted_content));
      effective = merged.effective;
      overlayApplied = overlayApplied || merged.overlayApplied;
    }
    sourceVersionIds.push(row.version_id);
    sourceRefs.push(row.source_ref);
    approvalRefs.push(row.approval_ref);
    bindingScopesApplied.push(row.binding_scope);
  }

  const strongest = layeredRowsByTemplate[layeredRowsByTemplate.length - 1]!;
  const userOverlay = jsonObject(strongest.overlay_json);
  if (Object.keys(userOverlay).length > 0) {
    const merged = applyAllowedOverlay(effective, userOverlay);
    effective = merged.effective;
    overlayApplied = overlayApplied || merged.overlayApplied;
    bindingScopesApplied.push('user overlay personalization');
  }

  return {
    strongest,
    effective,
    overlayApplied,
    sourceVersionIds: [...new Set(sourceVersionIds)],
    sourceRefs: [...new Set(sourceRefs)],
    approvalRefs: [...new Set(approvalRefs)],
    bindingScopesApplied: [...new Set(bindingScopesApplied)],
  };
}

function requireShortText(name: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw makeError('VALIDATION_ERROR', `${name} must be a non-empty string <= ${max} chars`, 400);
  }
  return value.trim();
}

export async function listEffectiveTemplateSnapshotsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  opts: TemplatePolicyListOpts = {},
): Promise<EffectiveTemplateSnapshot[]> {
  assertWorkspaceScope(workspaceId);
  const limit = limitFor(opts.limit);
  const [rows] = await withWorkspaceRlsContext<[EffectiveTemplateSnapshot[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT id, workspace_id, template_id, user_id, snapshot_hash, effective_template,
        source_version_ids, evidence_ref_ids, created_at
      FROM effective_template_snapshots
      WHERE workspace_id = ${workspaceId}
        AND (${opts.template_id ?? null}::text IS NULL OR template_id = ${opts.template_id ?? null})
        AND (${opts.user_id ?? null}::text IS NULL OR user_id = ${opts.user_id ?? null})
      ORDER BY created_at DESC
      LIMIT ${limit}
    `,
  ], { readOnly: true });
  return rows.map((row) => ({
    ...row,
    user_id: row.user_id ?? null,
    effective_template: jsonObject(row.effective_template),
    source_version_ids: Array.isArray(row.source_version_ids) ? row.source_version_ids.map(String) : [],
    evidence_ref_ids: Array.isArray(row.evidence_ref_ids) ? row.evidence_ref_ids.map(String) : [],
  }));
}

export async function resolveEffectiveTemplatesRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  opts: TemplatePolicyListOpts = {},
): Promise<EffectiveTemplateEnvelope[]> {
  assertWorkspaceScope(workspaceId);
  const limit = limitFor(opts.limit);
  const templateKey = opts.template_key?.trim() || null;
  const templateId = opts.template_id?.trim() || null;
  const userId = opts.user_id || actorUserId;

  const [rows] = await withWorkspaceRlsContext<[TemplateProjectionRow[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      SELECT
        td.id AS template_id,
        td.template_key,
        td.name,
        td.category,
        tb.binding_scope,
        tv.id AS version_id,
        tv.version,
        tv.content_sha256,
        tv.redacted_content,
        tv.source_ref,
        tv.source_sha,
        tv.approval_ref,
        tv.lifecycle_state,
        uo.overlay_json,
        tb.updated_at
      FROM tenant_template_bindings tb
      JOIN template_definitions td ON td.id = tb.template_id
      JOIN template_versions tv ON tv.id = tb.version_id
      LEFT JOIN user_template_overlays uo
        ON uo.workspace_id = tb.workspace_id
       AND uo.template_id = tb.template_id
       AND uo.user_id = ${userId}
       AND uo.lifecycle_state = 'active'
      WHERE tb.workspace_id = ${workspaceId}
        AND tb.lifecycle_state = 'active'
        AND tv.lifecycle_state IN ('approved', 'active')
        -- OAR-W3 (260713): safe-tier-only BY CONSTRUCTION — internal_sensitive rows can never reach a
        -- customer even if a publisher bug wrote one. SCHEMA-TOLERANT deliberately: the classification
        -- column arrives with mig-070, and this reader is LIVE in prod — a bare td.classification would
        -- 500 the route if the code deploys before the operator applies 070. to_jsonb(td)->>'classification'
        -- is NULL pre-070 (treated as customer_visible legacy) and enforces for real once 070 lands.
        AND COALESCE(to_jsonb(td)->>'classification', 'customer_visible') IN ('public', 'customer_visible')
        AND (${templateId}::text IS NULL OR td.id = ${templateId})
        AND (${templateKey}::text IS NULL OR td.template_key = ${templateKey})
      ORDER BY tb.updated_at DESC
      LIMIT ${limit}
    `,
  ], { readOnly: true });

  const layeredRowsByTemplate = new Map<string, TemplateProjectionRow[]>();
  for (const row of rows) {
    const group = layeredRowsByTemplate.get(row.template_id) || [];
    group.push(row);
    layeredRowsByTemplate.set(row.template_id, group);
  }

  return Array.from(layeredRowsByTemplate.values()).map((templateRows) => {
    const {
      strongest: row,
      effective,
      overlayApplied,
      sourceVersionIds,
      sourceRefs,
      approvalRefs,
      bindingScopesApplied,
    } = mergeLayeredTemplateRows(templateRows);
    return {
      template_id: row.template_id,
      template_key: row.template_key,
      name: row.name,
      category: row.category,
      binding_scope: row.binding_scope,
      binding_scopes_applied: bindingScopesApplied,
      version_id: row.version_id,
      version: row.version,
      source_version_ids: sourceVersionIds,
      content_sha256: row.content_sha256,
      approval_ref: row.approval_ref,
      approval_refs: approvalRefs,
      source_ref: row.source_ref,
      source_refs: sourceRefs,
      source_sha: row.source_sha,
      lifecycle_state: row.lifecycle_state,
      effective_template: effective,
      overlay_applied: overlayApplied,
      resolution_order: [...INHERITANCE_ORDER],
      resolution_strategy: 'layered_inheritance_v2',
      forbidden_override_keys: [...FORBIDDEN_OVERRIDE_KEYS],
    };
  });
}

export interface StarterTemplateBindingSeedResult {
  seeded: number;
  skipped: boolean;
}

// Y-wave SEED · ADR-XB-012 · bind a newly-provisioned workspace to the PUBLISHED platform template
// catalog so resolveEffectiveTemplates returns a non-empty starter set for that workspace. Runs
// OWNER-CONNECTED at provisioning: mig-070 gives the runtime app role NO write grant on the template
// registry (writes are owner-connected; RLS governs app-role READS), so this must use the raw owner
// `sql`, never withWorkspaceRlsContext. Idempotent — a workspace already holding any active binding is
// skipped (re-provision never double-seeds). Binds ONLY approved/active, safe-tier
// (public/customer_visible) definitions — the exact tier resolveEffectiveTemplatesRow enforces — so a
// mis-published internal_sensitive row can never be bound. approval_ref honestly marks a PLATFORM
// DEFAULT (never a promoted-learning approval — cf. tenant_learning_profiles). If the catalog is
// unpublished this binds nothing (honest-empty); the caller treats any throw as non-fatal so
// provisioning is never affected.
export async function seedStarterTemplateBindingsRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  ownerUserId: UserId,
): Promise<StarterTemplateBindingSeedResult> {
  assertWorkspaceScope(workspaceId);
  const rows = (await sql/*sql*/`
    WITH existing AS (
      SELECT 1 FROM tenant_template_bindings
      WHERE workspace_id = ${workspaceId} AND lifecycle_state = 'active'
      LIMIT 1
    ),
    publishable AS (
      SELECT td.id AS template_id, tv.id AS version_id,
             row_number() OVER (PARTITION BY td.id ORDER BY tv.created_at DESC, tv.id) AS rn
      FROM template_definitions td
      JOIN template_versions tv ON tv.template_id = td.id
      WHERE tv.lifecycle_state IN ('approved', 'active')
        AND COALESCE(to_jsonb(td)->>'classification', 'customer_visible') IN ('public', 'customer_visible')
    ),
    inserted AS (
      INSERT INTO tenant_template_bindings
        (id, workspace_id, template_id, version_id, binding_scope, lifecycle_state, approved_by, approval_ref)
      SELECT 'ttb_' || substr(md5(${workspaceId}::text || ':' || p.template_id), 1, 24),
             ${workspaceId}, p.template_id, p.version_id, 'workspace', 'active',
             ${ownerUserId}, 'platform-default-seed'
      FROM publishable p
      WHERE p.rn = 1 AND NOT EXISTS (SELECT 1 FROM existing)
      RETURNING 1
    )
    SELECT COALESCE((SELECT count(*) FROM inserted), 0)::int AS seeded,
           EXISTS (SELECT 1 FROM existing) AS skipped
  `) as unknown as Array<{ seeded: number; skipped: boolean }>;
  const row = rows[0] ?? { seeded: 0, skipped: false };
  return { seeded: Number(row.seeded) || 0, skipped: Boolean(row.skipped) };
}

export async function createTemplateAdminApprovalRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: TemplateAdminApprovalInput,
): Promise<TemplateAdminApproval> {
  assertWorkspaceScope(workspaceId);
  const id = input.id?.trim() || `tap_${randomNanoid()}`;
  const approvalRef = requireShortText('approval_ref', input.approval_ref, 240);
  const action = requireShortText('action', input.action, 160);
  const status = input.status || 'approved';
  if (!['requested', 'approved', 'rejected', 'cancelled'].includes(status)) {
    throw makeError('VALIDATION_ERROR', 'invalid approval status', 400);
  }

  const [rows] = await withWorkspaceRlsContext<[TemplateAdminApproval[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      INSERT INTO template_admin_approvals (
        id, workspace_id, approval_ref, actor_user_id, action, status,
        evidence_ref_id, rollback_snapshot_id, decided_at
      ) VALUES (
        ${id}, ${workspaceId}, ${approvalRef}, ${actorUserId}, ${action},
        ${status}, ${input.evidence_ref_id ?? null}, ${input.rollback_snapshot_id ?? null},
        CASE WHEN ${status} IN ('approved', 'rejected', 'cancelled') THEN now() ELSE NULL END
      )
      RETURNING id, workspace_id, approval_ref, actor_user_id, action, status,
        evidence_ref_id, rollback_snapshot_id, created_at, decided_at
    `,
  ]);
  return {
    ...rows[0]!,
    evidence_ref_id: rows[0]!.evidence_ref_id ?? null,
    rollback_snapshot_id: rows[0]!.rollback_snapshot_id ?? null,
    decided_at: rows[0]!.decided_at ?? null,
  };
}

export async function getEffectivePersonalizationProfileRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  roleKey = 'member',
): Promise<EffectivePersonalizationProfile> {
  assertWorkspaceScope(workspaceId);
  const normalizedRole = roleKey.trim() || 'member';
  const [tenantRows, userRows] = await withWorkspaceRlsContext<[TenantLearningProfileRow[], UserPersonalizationProfileRow[]]>(
    sql,
    workspaceId,
    (tx) => [
      tx/*sql*/`
        SELECT shared_rules_json, shared_skills_json, shared_defaults_json,
          source_signal_ids, approval_ref
        FROM tenant_learning_profiles
        WHERE workspace_id = ${workspaceId}
          AND lifecycle_state = 'active'
          AND role_key IN ('all', ${normalizedRole})
        ORDER BY updated_at ASC
      `,
      tx/*sql*/`
        SELECT preference_json, personal_rules_json, personal_skills_json,
          learned_defaults_json, source_signal_ids
        FROM user_personalization_profiles
        WHERE workspace_id = ${workspaceId}
          AND user_id = ${actorUserId}
          AND role_key = ${normalizedRole}
          AND lifecycle_state = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
      `,
    ],
    { readOnly: true },
  );

  const companyRules: Record<string, unknown> = {};
  const companySkills: Record<string, unknown> = {};
  const companyDefaults: Record<string, unknown> = {};
  const approvalRefs: string[] = [];
  for (const row of tenantRows) {
    Object.assign(companyRules, jsonObject(row.shared_rules_json));
    Object.assign(companySkills, jsonObject(row.shared_skills_json));
    Object.assign(companyDefaults, jsonObject(row.shared_defaults_json));
    if (row.approval_ref) approvalRefs.push(row.approval_ref);
  }

  const user = userRows[0];
  const userPreferences = jsonObject(user?.preference_json);
  const personalRules = jsonObject(user?.personal_rules_json);
  const personalSkills = jsonObject(user?.personal_skills_json);
  const learnedDefaults = jsonObject(user?.learned_defaults_json);
  const sourceSignalIds = Array.isArray(user?.source_signal_ids) ? user!.source_signal_ids.map(String) : [];

  return {
    schema_id: 'xlooop.effective_personalization_profile.v1',
    workspace_id: workspaceId,
    user_id: actorUserId,
    role_key: normalizedRole,
    company_profile: {
      rules: companyRules,
      skills: companySkills,
      defaults: companyDefaults,
      approval_refs: [...new Set(approvalRefs)],
    },
    user_profile: {
      preferences: userPreferences,
      personal_rules: personalRules,
      personal_skills: personalSkills,
      learned_defaults: learnedDefaults,
      source_signal_ids: sourceSignalIds,
    },
    effective_profile: {
      rules: { ...companyRules, ...personalRules },
      skills: { ...companySkills, ...personalSkills },
      defaults: { ...companyDefaults, ...learnedDefaults },
      preferences: userPreferences,
    },
    privacy_model: 'private_by_default_with_explicit_company_promotion',
    forbidden_override_keys: [...FORBIDDEN_OVERRIDE_KEYS],
  };
}

export async function createUserLearningSignalRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: UserLearningSignalInput,
): Promise<UserLearningSignal> {
  assertWorkspaceScope(workspaceId);
  const id = input.id?.trim() || `uls_${randomNanoid()}`;
  const classification = input.classification || 'user_private';
  const promotionState = input.promotion_state || (classification === 'tenant_share_candidate' ? 'candidate' : 'private');
  if (classification !== 'user_private' && !input.consent_ref) {
    throw makeError('VALIDATION_ERROR', 'tenant-share learning signals require consent_ref', 400);
  }
  const signalJson = requireAllowedLearningPayload('signal_json', input.signal_json);
  const signalJsonText = JSON.stringify(signalJson);

  const [rows] = await withWorkspaceRlsContext<[UserLearningSignal[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      INSERT INTO user_learning_signals (
        id, workspace_id, user_id, signal_kind, source_kind, signal_json,
        classification, promotion_state, consent_ref, evidence_ref_id
      ) VALUES (
        ${id}, ${workspaceId}, ${actorUserId}, ${input.signal_kind}, ${input.source_kind},
        ${signalJsonText}::jsonb, ${classification}, ${promotionState},
        ${input.consent_ref ?? null}, ${input.evidence_ref_id ?? null}
      )
      RETURNING id, workspace_id, user_id, signal_kind, source_kind, signal_json,
        classification, promotion_state, consent_ref, evidence_ref_id, created_at, updated_at
    `,
  ]);

  return {
    ...rows[0]!,
    signal_json: jsonObject(rows[0]!.signal_json),
    consent_ref: rows[0]!.consent_ref ?? null,
    evidence_ref_id: rows[0]!.evidence_ref_id ?? null,
  };
}

export async function createTenantLearningPromotionRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: TenantLearningPromotionInput,
): Promise<TenantLearningPromotion> {
  assertWorkspaceScope(workspaceId);
  const id = input.id?.trim() || `tlp_${randomNanoid()}`;
  const targetProfileKey = requireShortText('target_profile_key', input.target_profile_key, 160);
  const approvalRef = requireShortText('approval_ref', input.approval_ref, 240);
  const payload = requireAllowedLearningPayload('promotion_payload', input.promotion_payload);
  const payloadText = JSON.stringify(payload);
  const status = input.status || 'requested';
  if (!['requested', 'approved', 'rejected', 'cancelled'].includes(status)) {
    throw makeError('VALIDATION_ERROR', 'invalid learning promotion status', 400);
  }

  const [rows] = await withWorkspaceRlsContext<[TenantLearningPromotion[]]>(sql, workspaceId, (tx) => [
    tx/*sql*/`
      INSERT INTO tenant_learning_promotions (
        id, workspace_id, source_user_id, promoted_by_user_id, signal_id,
        target_profile_key, promotion_payload, approval_ref, evidence_ref_id,
        status, decided_at
      ) VALUES (
        ${id}, ${workspaceId}, ${input.source_user_id}, ${actorUserId},
        ${input.signal_id}, ${targetProfileKey}, ${payloadText}::jsonb, ${approvalRef},
        ${input.evidence_ref_id ?? null}, ${status},
        CASE WHEN ${status} IN ('approved', 'rejected', 'cancelled') THEN now() ELSE NULL END
      )
      RETURNING id, workspace_id, source_user_id, promoted_by_user_id, signal_id,
        target_profile_key, promotion_payload, approval_ref, evidence_ref_id,
        status, created_at, decided_at
    `,
  ]);

  return {
    ...rows[0]!,
    promotion_payload: jsonObject(rows[0]!.promotion_payload),
    evidence_ref_id: rows[0]!.evidence_ref_id ?? null,
    decided_at: rows[0]!.decided_at ?? null,
  };
}

export const TEMPLATE_POLICY_INHERITANCE_ORDER = INHERITANCE_ORDER;
export const TEMPLATE_POLICY_FORBIDDEN_OVERRIDE_KEYS = FORBIDDEN_OVERRIDE_KEYS;
