import { classifyActionIntent } from './action-intent';
import type {
  ApprovalRequest,
  IntakeContextSummary,
  IntakeOperation,
  IntakeResolutionInput,
  IntakeTarget,
  Project,
  TaskPacket,
} from '../dal/types';
import type { ContextReference } from './context-reference';

export interface IntakeResolveRequest {
  text: string;
  client_request_id: string;
  interaction_id?: string;
  project_id?: string | null;
  target?: { type?: string; id?: string | null } | null;
  context_refs?: ContextReference[];
}

export interface IntakeResolveInventory {
  packets: TaskPacket[];
  approvals: ApprovalRequest[];
  projects: Project[];
  authorityFor: (operation: IntakeOperation) => { allowed: boolean; safe_reason: string };
  now: Date;
}

const ACTIVE_PACKET_STATES = new Set(['draft', 'ready', 'in_progress', 'evidence_ready', 'approval_requested']);

function titleFor(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const explicitlyNamed = clean.match(/\b(?:titled|called|named)\s+["']([^"']{1,160})["']/i)?.[1]?.trim();
  if (explicitlyNamed) return explicitlyNamed;
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

function normalizedProjectText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
}

function explicitProjectQualifier(text: string): string | null {
  const value = text.match(/\b(?:in|for|under)\s+([^.!?\n]{2,200}?)\s+(?:titled|called|named)\s+["']/i)?.[1];
  return value?.replace(/\s+/g, ' ').trim() || null;
}

function canonicalProjectIdsInQualifier(qualifier: string, projects: Project[]): Project[] {
  return projects.filter((project) => {
    const escaped = project.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`).test(qualifier);
  });
}

function resolveCreateProject(
  request: IntakeResolveRequest,
  projects: Project[],
): { project: Project | null; targetWasRequested: boolean; ambiguous: boolean } {
  const active = projects.filter((project) => project.status === 'active');
  if (request.project_id) {
    const exact = active.filter((project) => project.id === request.project_id);
    return { project: exact.length === 1 ? exact[0]! : null, targetWasRequested: true, ambiguous: exact.length !== 1 };
  }

  const requestedQualifier = explicitProjectQualifier(request.text);
  const canonicalIdMatches = requestedQualifier
    ? canonicalProjectIdsInQualifier(requestedQualifier, active)
    : [];
  if (canonicalIdMatches.length > 0) {
    return {
      project: canonicalIdMatches.length === 1 ? canonicalIdMatches[0]! : null,
      targetWasRequested: true,
      ambiguous: canonicalIdMatches.length !== 1,
    };
  }

  const requestedName = requestedQualifier;
  if (requestedName) {
    const normalizedName = normalizedProjectText(requestedName);
    const exact = active.filter((project) => normalizedProjectText(project.name) === normalizedName);
    return { project: exact.length === 1 ? exact[0]! : null, targetWasRequested: true, ambiguous: exact.length !== 1 };
  }

  return { project: null, targetWasRequested: false, ambiguous: false };
}

function contextSummary(refs: IntakeResolveRequest['context_refs']): IntakeContextSummary {
  const rows = Array.isArray(refs) ? refs : [];
  const documentIds = rows.filter((r) => r.kind === 'document').map((r) => r.id);
  return {
    reference_count: rows.length,
    source_count: rows.filter((r) => r?.kind === 'source').length,
    evidence_count: rows.filter((r) => r.kind === 'evidence' || r.kind === 'document').length,
    ...(documentIds.length ? { document_ids: documentIds } : {}),
  };
}

function selected<T extends { id: string }>(rows: T[], requested: string | null | undefined): T[] {
  return requested ? rows.filter((row) => row.id === requested) : rows;
}

export function buildIntakeResolution(
  request: IntakeResolveRequest,
  requestDigest: string,
  inventory: IntakeResolveInventory,
): IntakeResolutionInput {
  const classified = classifyActionIntent(request.text);
  const operation = classified.action_intent;
  const authority = inventory.authorityFor(operation);
  const expiresAt = new Date(inventory.now.getTime() + 15 * 60 * 1000).toISOString();
  const base = {
    project_id: request.project_id ?? null,
    client_request_id: request.client_request_id,
    interaction_id: request.interaction_id ?? request.client_request_id,
    request_digest: requestDigest,
    operation,
    confidence: classified.confidence,
    ambiguity: false,
    authority,
    context_summary: contextSummary(request.context_refs),
    required_tools: [] as string[],
    current_work_version: Math.max(0, ...inventory.packets.map((p) => Number(p.version) || 0)),
    expires_at: expiresAt,
  };

  if (operation === 'answer' || operation === 'inspect') {
    return {
      ...base,
      target: { type: 'read_model', id: null, label: 'Current workspace facts' },
      effect_summary: operation === 'inspect' ? 'Inspect the current workspace without changing it.' : 'Answer from governed workspace facts without creating work.',
      risk: 'low', requires_confirmation: false, next_step: authority.allowed ? 'answer_now' : 'blocked', action_payload: {},
    };
  }
  if (operation === 'plan') {
    return {
      ...base,
      target: { type: 'none', id: null, label: 'Draft plan' },
      effect_summary: 'Draft a plan for review. No governed work is created until you approve it.',
      risk: 'low', requires_confirmation: false, next_step: authority.allowed ? 'draft_plan' : 'blocked', action_payload: {},
    };
  }
  if (operation === 'create_work') {
    const title = titleFor(request.text);
    const projectResolution = resolveCreateProject(request, inventory.projects);
    if (projectResolution.targetWasRequested && (!projectResolution.project || projectResolution.ambiguous)) {
      return {
        ...base,
        ambiguity: true,
        target: { type: 'none', id: null, label: 'Project clarification required' },
        effect_summary: 'Choose one active project before anything is created.',
        risk: 'low', requires_confirmation: false, next_step: 'clarify', action_payload: {},
      };
    }
    const project = projectResolution.project;
    const destination = project ? ` in ${project.name} (${project.id})` : '';
    return {
      ...base,
      project_id: project?.id ?? request.project_id ?? null,
      target: { type: 'task_packet', id: null, label: `${title}${destination}` },
      effect_summary: `Create one governed work item${destination}: ${title}`,
      risk: 'medium', requires_confirmation: true, next_step: authority.allowed ? 'confirm' : 'blocked',
      action_payload: {
        title,
        summary: request.text.trim(),
        project_id: project?.id ?? request.project_id ?? null,
        ...(project ? { project_name: project.name } : {}),
      },
    };
  }
  if (operation === 'continue_work') {
    const active = selected(inventory.packets.filter((p) => ACTIVE_PACKET_STATES.has(p.lifecycle_state)), request.target?.id);
    const target = active.length === 1
      ? { type: 'task_packet' as const, id: active[0]!.id, label: active[0]!.title }
      : { type: 'none' as const, id: null, label: active.length ? `${active.length} active work items` : 'No active work item' };
    return {
      ...base, target,
      ambiguity: active.length !== 1,
      effect_summary: active.length === 1 ? `Continue ${active[0]!.title} and mark it in progress.` : 'Choose the work item to continue.',
      risk: 'medium', requires_confirmation: active.length === 1,
      next_step: !authority.allowed ? 'blocked' : active.length === 1 ? 'confirm' : 'clarify',
      action_payload: active.length === 1 ? { packet_id: active[0]!.id, packet_version: active[0]!.version } : {},
    };
  }
  if (operation === 'decide') {
    const pending = selected(inventory.approvals.filter((a) => a.status === 'requested'), request.target?.id);
    const decision = /\b(reject|decline|deny)\b/i.test(request.text) ? 'rejected' : /\b(cancel|withdraw)\b/i.test(request.text) ? 'cancelled' : 'approved';
    const target: IntakeTarget = pending.length === 1
      ? { type: 'approval', id: pending[0]!.id, label: pending[0]!.reason }
      : { type: 'none', id: null, label: pending.length ? `${pending.length} pending approvals` : 'No pending approval' };
    return {
      ...base, target,
      ambiguity: pending.length !== 1,
      effect_summary: pending.length === 1 ? `${decision === 'approved' ? 'Approve' : decision === 'rejected' ? 'Reject' : 'Cancel'} the selected approval request.` : 'Choose the approval request and decision.',
      risk: 'high', requires_confirmation: pending.length === 1,
      next_step: !authority.allowed ? 'blocked' : pending.length === 1 ? 'confirm' : 'clarify',
      action_payload: pending.length === 1 ? { approval_id: pending[0]!.id, decision } : {},
    };
  }
  return {
    ...base,
    target: { type: 'none', id: null, label: 'Clarification required' },
    effect_summary: 'Clarify the intended outcome before anything is created or changed.',
    risk: 'low', ambiguity: true, requires_confirmation: false, next_step: 'clarify', action_payload: {},
  };
}
