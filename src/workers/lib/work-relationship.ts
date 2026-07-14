// Typed work-relationship contract. Pure and customer-safe; persistence is migration 074.

export type WorkRelationshipTargetKind = 'packet' | 'goal';
export type PacketRelationshipType = 'depends_on' | 'blocks' | 'supersedes' | 'duplicates';
export type GoalRelationshipType = 'advances' | 'contributes_to' | 'measures' | 'blocked_by';
export type WorkRelationshipType = PacketRelationshipType | GoalRelationshipType;

const PACKET_RELATIONSHIPS: ReadonlySet<string> = new Set(['depends_on', 'blocks', 'supersedes', 'duplicates']);
const GOAL_RELATIONSHIPS: ReadonlySet<string> = new Set(['advances', 'contributes_to', 'measures', 'blocked_by']);

export interface WorkRelationshipInput {
  source_packet_id: string;
  target_kind: WorkRelationshipTargetKind;
  target_id: string;
  relationship_type: string;
}

export interface WorkRelationshipVerdict {
  valid: boolean;
  errors: string[];
  normalized: (WorkRelationshipInput & { relationship_type: WorkRelationshipType }) | null;
}

export function validateWorkRelationship(input: WorkRelationshipInput): WorkRelationshipVerdict {
  const source = input.source_packet_id.trim();
  const target = input.target_id.trim();
  const relationship = input.relationship_type.trim();
  const errors: string[] = [];
  if (!source) errors.push('source_packet_id is required');
  if (!target) errors.push('target_id is required');
  if (input.target_kind !== 'packet' && input.target_kind !== 'goal') errors.push('target_kind must be packet or goal');
  const allowed = input.target_kind === 'packet' ? PACKET_RELATIONSHIPS : GOAL_RELATIONSHIPS;
  if (!allowed.has(relationship)) errors.push(`${relationship || '<empty>'} is invalid for a ${input.target_kind} target`);
  if (input.target_kind === 'packet' && source === target) errors.push('a packet cannot relate to itself');
  return {
    valid: errors.length === 0,
    errors,
    normalized: errors.length ? null : {
      source_packet_id: source,
      target_kind: input.target_kind,
      target_id: target,
      relationship_type: relationship as WorkRelationshipType,
    },
  };
}
