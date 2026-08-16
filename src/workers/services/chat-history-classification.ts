export type CommercialChatHistoryClass =
  | 'user_input'
  | 'live_assistant_turn'
  | 'legacy_non_live_projection';

export interface CommercialChatCitation {
  kind: 'workspace' | 'project' | 'plan_entity' | 'event' | 'document';
  ref?: string;
  label?: string;
  entity_kind?: string;
}

function text(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

/** Rebuild the customer-safe citation projection from the grounding receipt persisted with the answer. */
export function projectCommercialChatCitations(groundedOn: unknown): CommercialChatCitation[] {
  if (!groundedOn || typeof groundedOn !== 'object' || Array.isArray(groundedOn)) return [];
  const grounded = groundedOn as Record<string, unknown>;
  const workspace = grounded.workspace && typeof grounded.workspace === 'object' && !Array.isArray(grounded.workspace)
    ? grounded.workspace as Record<string, unknown>
    : {};
  const plan = grounded.plan && typeof grounded.plan === 'object' && !Array.isArray(grounded.plan)
    ? grounded.plan as Record<string, unknown>
    : {};
  const documents = grounded.documents && typeof grounded.documents === 'object' && !Array.isArray(grounded.documents)
    ? grounded.documents as Record<string, unknown>
    : {};
  const citations: CommercialChatCitation[] = [];
  const workspaceId = text(workspace.id);
  const projectId = text(plan.project_id);

  if (workspaceId) citations.push({ kind: 'workspace', ref: workspaceId, label: text(workspace.name) ?? undefined });
  if (projectId) citations.push({ kind: 'project', ref: projectId, label: text(plan.project_name) ?? undefined });
  for (const entity of Array.isArray(plan.entities) ? plan.entities : []) {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) continue;
    const row = entity as Record<string, unknown>;
    const ref = text(row.id);
    if (!ref) continue;
    citations.push({
      kind: 'plan_entity',
      ref,
      label: text(row.title) ?? undefined,
      entity_kind: text(row.kind) ?? undefined,
    });
  }
  for (const value of Array.isArray(grounded.event_ids) ? grounded.event_ids : []) {
    const ref = text(value);
    if (ref) citations.push({ kind: 'event', ref });
  }
  for (const value of Array.isArray(documents.names) ? documents.names : []) {
    const label = text(value);
    if (label) citations.push({ kind: 'document', label });
  }
  return citations;
}

/** Preserve legacy rows for audit while preventing them from masquerading as current live AI. */
export function classifyCommercialChatHistory(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const row = message as Record<string, unknown>;
    const assistant = row.role === 'assistant';
    const live = assistant && row.generated_by === 'llm';
    const activityClass: CommercialChatHistoryClass = assistant
      ? live ? 'live_assistant_turn' : 'legacy_non_live_projection'
      : 'user_input';
    const citations = assistant ? projectCommercialChatCitations(row.grounded_on) : [];
    return {
      ...row,
      activity_class: activityClass,
      is_live_assistant: live,
      citations,
      citation_count: citations.length,
      commercial_render_policy: activityClass === 'legacy_non_live_projection'
        ? 'historical_projection_only'
        : 'standard',
    };
  });
}
