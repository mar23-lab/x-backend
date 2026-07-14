import { describe, expect, it } from 'vitest';
import { validateWorkRelationship } from '../lib/work-relationship';

describe('typed work relationships', () => {
  it.each(['depends_on', 'blocks', 'supersedes', 'duplicates'])('accepts packet -> packet %s', (relationship_type) => {
    expect(validateWorkRelationship({ source_packet_id: 'pkt_a', target_kind: 'packet', target_id: 'pkt_b', relationship_type })).toMatchObject({ valid: true });
  });

  it.each(['advances', 'contributes_to', 'measures', 'blocked_by'])('accepts packet -> goal %s', (relationship_type) => {
    expect(validateWorkRelationship({ source_packet_id: 'pkt_a', target_kind: 'goal', target_id: 'goal_1', relationship_type })).toMatchObject({ valid: true });
  });

  it('rejects vocabulary borrowed across target kinds', () => {
    expect(validateWorkRelationship({ source_packet_id: 'pkt_a', target_kind: 'goal', target_id: 'goal_1', relationship_type: 'depends_on' }).valid).toBe(false);
    expect(validateWorkRelationship({ source_packet_id: 'pkt_a', target_kind: 'packet', target_id: 'pkt_b', relationship_type: 'advances' }).valid).toBe(false);
  });

  it('rejects packet self-edges and empty ids', () => {
    expect(validateWorkRelationship({ source_packet_id: 'pkt_a', target_kind: 'packet', target_id: 'pkt_a', relationship_type: 'blocks' }).valid).toBe(false);
    expect(validateWorkRelationship({ source_packet_id: '', target_kind: 'goal', target_id: '', relationship_type: 'advances' }).errors).toHaveLength(2);
  });
});
