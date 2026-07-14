import { describe, expect, it } from 'vitest';
import { evaluateTaskPacketCompletionRow } from '../dal/operational-spine-store';
import type { Sql } from '../db/client';

type Captured = { text: string; params: unknown[] };

function fakeSql(row: Record<string, unknown> | null) {
  const captured: Captured[] = [];
  const tag = (strings: TemplateStringsArray, ...params: unknown[]) => ({ text: strings.join('$'), params });
  const sql = Object.assign(tag, {
    transaction: async (build: (tx: typeof tag) => Captured[]) => {
      const queries = build(tag);
      captured.push(...queries);
      return [[{ workspace_context: 'tenant_a' }], row ? [row] : []];
    },
  }) as unknown as Sql;
  return { sql, captured };
}

const PASSING_FACTS = {
  packet_id: 'pkt_1',
  packet_version: 3,
  requested_output: 'Verified customer-safe release packet',
  acceptance_criteria: ['tests pass'],
  acceptance_status: 'passed',
  evidence_required: true,
  execution_status: 'succeeded',
  blockers_accepted: false,
  approval_required: true,
  receipt_required: true,
  plan_projection_required: true,
  plan_projection_updated_at: '2026-07-14T01:01:00.000Z',
  packet_updated_at: '2026-07-14T01:00:00.000Z',
  evidence_attached_count: '2',
  receipt_count: '1',
  open_blocker_count: '0',
  approved_version: '3',
};

describe('server-derived packet completion facts', () => {
  it('passes only from tenant-scoped persisted facts', async () => {
    const { sql, captured } = fakeSql(PASSING_FACTS);
    const result = await evaluateTaskPacketCompletionRow(sql, 'tenant_a', 'pkt_1');
    expect(result).toMatchObject({ packet_id: 'pkt_1', packet_version: 3, can_complete: true });
    expect(result?.unmet_reasons).toEqual([]);
    expect(captured[0]?.text).toContain("set_config('xlooop.current_workspace_id'");
    expect(captured[1]?.text).toContain('p.workspace_id = $');
    expect(captured[1]?.text).toContain('ar.packet_version');
    expect(captured[1]?.params).toEqual(['tenant_a', 'pkt_1']);
  });

  it('rejects a stale approval after packet revision', async () => {
    const { sql } = fakeSql({ ...PASSING_FACTS, packet_version: 4, approved_version: '3' });
    const result = await evaluateTaskPacketCompletionRow(sql, 'tenant_a', 'pkt_1');
    expect(result?.can_complete).toBe(false);
    expect(result?.facts.approval_present_for_current_version).toBe(false);
    expect(result?.unmet_reasons.join(' ')).toContain('approval is stale');
  });

  it('returns null without leaking whether another tenant owns the packet', async () => {
    const { sql } = fakeSql(null);
    expect(await evaluateTaskPacketCompletionRow(sql, 'tenant_a', 'pkt_other')).toBeNull();
  });
});
