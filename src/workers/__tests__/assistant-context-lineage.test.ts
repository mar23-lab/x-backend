import { describe, expect, it } from 'vitest';
import { completeAssistantSkillLineage, persistAssistantContextLineage } from '../lib/assistant-context-lineage';

function makeSql() {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: strings.join(' ? ').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve([]);
  };
  sql.calls = calls;
  return sql;
}

const input = {
  workspace_id: 'tenant_a',
  principal_id: 'user_a',
  role: 'viewer',
  mode: 'ask',
  intent_ref: `sha256:${'a'.repeat(64)}`,
  scope: { event_count: 4, document_count: 0, unpromoted_document_count: 0, source_count: 1 },
  redaction_profile: 'viewer-limited',
  client_empty: false,
};

describe('assistant context lineage', () => {
  it('fails closed when the customer-safe role/skill catalog is unavailable', async () => {
    await expect(persistAssistantContextLineage(makeSql(), {}, input)).rejects.toThrow('catalog is not enabled');
  });

  it('persists resolution then context before a model run, without raw prompt text', async () => {
    const sql = makeSql();
    const lineage = await persistAssistantContextLineage(sql, { ROLE_SKILL_CATALOG_ENABLED: 'true' }, input, new Date('2026-07-15T00:00:00Z'));
    expect(lineage.action).toBe('assistant:answer');
    expect(lineage.resolution.verdict.allowed).toBe(true);
    expect(sql.calls.map((c: any) => c.query)).toEqual([
      expect.stringContaining('INSERT INTO role_skill_resolutions'),
      expect.stringContaining('INSERT INTO context_packets'),
    ]);
    expect(JSON.stringify(sql.calls)).not.toContain('raw customer prompt');
  });

  it('writes one completion receipt for the selected product skill', async () => {
    const sql = makeSql();
    const lineage = await persistAssistantContextLineage(sql, { ROLE_SKILL_CATALOG_ENABLED: 'true' }, input, new Date('2026-07-15T00:00:00Z'));
    const ids = await completeAssistantSkillLineage(sql, {}, lineage, input, new Date('2026-07-15T00:00:01Z'));
    expect(ids).toHaveLength(1);
    expect(sql.calls.at(-1).query).toContain('INSERT INTO skill_invocation_receipts');
  });
});
