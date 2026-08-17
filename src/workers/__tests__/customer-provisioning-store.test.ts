import { describe, it, expect } from 'vitest';
import { provisionCustomerWorkspaceRow } from '../dal/customer-provisioning-store';

function fakeSql() {
  const transactions: Array<Array<{ text: string; values: unknown[] }>> = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      text: (strings as unknown as string[]).join('?'),
      values,
    }),
    {
      transaction: async (queries: Array<{ text: string; values: unknown[] }>) => {
        transactions.push(queries);
        return [];
      },
    },
  );
  return { sql, transactions };
}

describe('provisionCustomerWorkspaceRow', () => {
  it('mirrors the approver before authority FK writes and links the access request after workspace creation', async () => {
    const { sql, transactions } = fakeSql();
    await provisionCustomerWorkspaceRow(sql as never, {
      accessRequestId: 'req_live_customer',
      clerkOrgId: 'org_hy12345',
      customerName: 'Honest & Young',
      customerSlug: 'honest-young',
      ownerClerkId: 'user_owner12345',
      approvedBy: 'user_operator99999',
      projectName: 'Honest & Young onboarding',
      projectId: 'proj_honest-young_default',
      roadmap: [],
    });

    const queries = transactions[0] ?? [];
    const texts = queries.map((q) => q.text);
    const approverMirrorIndex = texts.findIndex((text) =>
      text.includes('INSERT INTO users') && text.includes('VALUES (?,') && text.includes('ON CONFLICT (id) DO UPDATE'),
    );
    const authorityIndex = texts.findIndex((text) => text.includes('INSERT INTO customer_authority_consents'));
    const linkIndex = texts.findIndex((text) => text.includes('UPDATE access_requests'));

    expect(approverMirrorIndex).toBeGreaterThanOrEqual(0);
    expect(authorityIndex).toBeGreaterThan(approverMirrorIndex);
    expect(linkIndex).toBeGreaterThan(authorityIndex);
    expect(texts[authorityIndex]).toContain('access_request_id');
    expect(texts[linkIndex]).toContain('invited_to_workspace_id');
    expect(texts[linkIndex]).toContain('user_id = COALESCE');
  });

  it('keeps identical roadmap retries idempotent and appends changed content as a stable revision', async () => {
    const input = {
      clerkOrgId: 'org_hy12345',
      customerName: 'Honest & Young',
      customerSlug: 'honest-young',
      ownerClerkId: 'user_owner12345',
      approvedBy: 'user_operator99999',
      projectName: 'Honest & Young onboarding',
      projectId: 'proj_honest-young_default',
      roadmap: [{ summary: 'Connect Gmail', body: 'Connect Gmail in Watch mode.' }],
    };

    const first = fakeSql();
    const replay = fakeSql();
    const changed = fakeSql();
    await provisionCustomerWorkspaceRow(first.sql as never, input);
    await provisionCustomerWorkspaceRow(replay.sql as never, input);
    await provisionCustomerWorkspaceRow(changed.sql as never, {
      ...input,
      roadmap: [{ ...input.roadmap[0], body: 'Connect Gmail read-only in Watch mode.' }],
    });

    const roadmapQuery = (queries: Array<{ text: string; values: unknown[] }>) =>
      queries.find((query) => query.text.includes('WITH base_event AS'))!;
    const firstRoadmap = roadmapQuery(first.transactions[0] ?? []);
    const replayRoadmap = roadmapQuery(replay.transactions[0] ?? []);
    const changedRoadmap = roadmapQuery(changed.transactions[0] ?? []);

    expect(firstRoadmap.text).toContain('ON CONFLICT (id) DO NOTHING');
    expect(firstRoadmap.text).not.toMatch(/DO UPDATE SET\s+(summary|body)/i);
    expect(firstRoadmap.text).toContain('summary IS NOT DISTINCT FROM');
    expect(firstRoadmap.values).toContain('evt_honest-young_roadmap_01');

    const revisionId = firstRoadmap.values.find((value) =>
      typeof value === 'string' && value.startsWith('evt_honest-young_roadmap_01_rev_'));
    const replayRevisionId = replayRoadmap.values.find((value) =>
      typeof value === 'string' && value.startsWith('evt_honest-young_roadmap_01_rev_'));
    const changedRevisionId = changedRoadmap.values.find((value) =>
      typeof value === 'string' && value.startsWith('evt_honest-young_roadmap_01_rev_'));

    expect(revisionId).toMatch(/^evt_honest-young_roadmap_01_rev_[a-f0-9]{16}$/);
    expect(replayRevisionId).toBe(revisionId);
    expect(changedRevisionId).not.toBe(revisionId);
  });
});
