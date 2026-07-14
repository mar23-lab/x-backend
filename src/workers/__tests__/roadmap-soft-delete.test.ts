// roadmap-soft-delete.test.ts · 044 (260706) · customer-recoverability guarantee for roadmap items.
//
// Asserts (against a recording sql mock): deleteRoadmapItemRow performs a SOFT delete (UPDATE
// deleted_at, never a hard DELETE), and restoreRoadmapItemRow clears the marker + returns the item.
import { describe, it, expect } from 'vitest';
import { deleteRoadmapItemRow, restoreRoadmapItemRow } from '../dal/roadmap-store';

// Records every tagged-template call; returns scripted results in order.
function makeSql(results: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let i = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(results[i++] ?? []);
  }) as never;
  return { sql, calls };
}

const ITEM = {
  id: 'itm_1', roadmap_id: 'r1', domain_id: 'd1', position: 0, title: 'T', description: null,
  status: 'planned', target_date: null, derived_from_project_id: null, derived_from_event_id: null,
  metadata: {}, created_at: '2026-07-06T00:00:00Z', updated_at: '2026-07-06T00:00:00Z',
};

describe('044 · roadmap item recoverability', () => {
  it('delete is a SOFT delete (UPDATE deleted_at, never hard DELETE)', async () => {
    // call0: soft-delete UPDATE RETURNING; call1: position re-pack; call2: audit insert
    const { sql, calls } = makeSql([[{ id: 'itm_1', roadmap_id: 'r1', domain_id: 'd1' }], [], []]);
    await deleteRoadmapItemRow(sql, 'itm_1', 'user_op');
    const del = calls[0]!;
    expect(del.text).toMatch(/UPDATE synthetic_domain_roadmap_items[\s\S]*SET deleted_at = now\(\)/);
    expect(del.text).not.toMatch(/DELETE\s+FROM/);
    // re-pack only ranks active rows
    expect(calls[1]!.text).toContain('deleted_at IS NULL');
  });

  it('restore clears deleted_at and returns the item', async () => {
    const { sql, calls } = makeSql([[ITEM], []]); // call0: restore UPDATE RETURNING; call1: audit
    const out = await restoreRoadmapItemRow(sql, 'itm_1', 'user_op');
    expect(calls[0]!.text).toMatch(/deleted_at = NULL/);
    expect(calls[0]!.text).toContain('WHERE id = ? AND deleted_at IS NOT NULL');
    expect(out.id).toBe('itm_1');
  });

  it('restore of a non-deleted / missing item 404s', async () => {
    const { sql } = makeSql([[]]); // UPDATE RETURNING no rows
    await expect(restoreRoadmapItemRow(sql, 'nope', 'user_op')).rejects.toThrow(/not found/);
  });
});
