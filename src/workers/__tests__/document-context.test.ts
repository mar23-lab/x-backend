import { describe, expect, it } from 'vitest';
import type { DalAdapter } from '../dal/DalAdapter';
import type { DocumentMeta } from '../dal/document-store';
import { parseContextReferences } from '../lib/context-reference';
import { resolveDocumentContext } from '../services/document-context';

const document = (overrides: Partial<DocumentMeta> = {}): DocumentMeta => ({
  id: 'doc_1',
  workspace_id: 'workspace_1',
  project_id: 'project_1',
  filename: 'brief.txt',
  content_type: 'text/plain',
  size_bytes: 24,
  extracted_text: 'The launch target is September.',
  uploaded_by: 'user_1',
  uploaded_at: '2026-08-02T00:00:00Z',
  status: 'recorded',
  admissibility: 'approved',
  content_hash: 'a'.repeat(64),
  version: 1,
  supersedes_id: null,
  ...overrides,
});

const dalWith = (rows: DocumentMeta[]) => ({
  listDocumentsByIds: async () => rows,
}) as unknown as DalAdapter;

describe('exact context references', () => {
  it('normalizes exact IDs and rejects kind-only or duplicate references', () => {
    expect(parseContextReferences([{ kind: 'document', id: ' doc_1 ' }])).toEqual([
      { kind: 'document', id: 'doc_1' },
    ]);
    expect(() => parseContextReferences([{ kind: 'document' }])).toThrow(/id must be/);
    expect(() => parseContextReferences([
      { kind: 'document', id: 'doc_1' },
      { kind: 'document', id: 'doc_1' },
    ])).toThrow(/duplicate/);
  });

  it('returns the selected document in request order after tenant, project, and role checks', async () => {
    const result = await resolveDocumentContext({
      dal: dalWith([document({ id: 'doc_2', filename: 'second.txt' }), document()]),
      workspace_id: 'workspace_1',
      project_id: 'project_1',
      user_id: 'user_1',
      role: 'owner',
      refs: [
        { kind: 'document', id: 'doc_1' },
        { kind: 'document', id: 'doc_2' },
      ],
    });
    expect(result.facts.map((row) => row.id)).toEqual(['doc_1', 'doc_2']);
    expect(result.facts[0]?.excerpt).toContain('September');
  });

  it.each([
    ['missing row', []],
    ['another project', [document({ project_id: 'project_2' })]],
    ['no extracted text', [document({ extracted_text: null })]],
    ['excluded', [document({ admissibility: 'excluded' })]],
    ['another user candidate', [document({ admissibility: 'candidate', uploaded_by: 'user_2' })]],
  ])('fails closed for %s', async (_label, rows) => {
    await expect(resolveDocumentContext({
      dal: dalWith(rows as DocumentMeta[]),
      workspace_id: 'workspace_1',
      project_id: 'project_1',
      user_id: 'user_1',
      role: 'owner',
      refs: [{ kind: 'document', id: 'doc_1' }],
    })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });
});
