import type { DalAdapter } from '../dal/DalAdapter';
import type { DocumentMeta } from '../dal/document-store';
import type { ContextReference } from '../lib/context-reference';
import { documentContextReferences } from '../lib/context-reference';
import { assembleRoleScopedContext } from './role-scoped-context';
import type { DocumentFact } from './cockpit-chat';

export class DocumentContextUnavailableError extends Error {
  readonly code = 'CONFLICT';
  readonly status = 409;

  constructor() {
    super('one or more selected documents are unavailable for this request');
    this.name = 'DocumentContextUnavailableError';
  }
}

export interface ResolvedDocumentContext {
  facts: DocumentFact[];
  documents: DocumentMeta[];
  unpromoted_count: number;
}

export async function resolveDocumentContext(input: {
  dal: DalAdapter;
  workspace_id: string;
  project_id: string | null;
  user_id: string;
  role: string;
  refs: readonly ContextReference[];
}): Promise<ResolvedDocumentContext> {
  const refs = documentContextReferences(input.refs);
  if (refs.length === 0) return { facts: [], documents: [], unpromoted_count: 0 };

  let rows: DocumentMeta[];
  try {
    rows = await input.dal.listDocumentsByIds(input.workspace_id, refs.map((ref) => ref.id));
  } catch (cause) {
    const err = new Error('selected document context could not be loaded') as Error & { code?: string; status?: number; cause?: unknown };
    err.code = 'SERVICE_UNAVAILABLE';
    err.status = 503;
    err.cause = cause;
    throw err;
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = refs.map((ref) => byId.get(ref.id));
  if (ordered.some((row) => !row)) throw new DocumentContextUnavailableError();

  const selected = ordered as DocumentMeta[];
  if (selected.some((row) =>
    row.workspace_id !== input.workspace_id
    || row.status === 'archived'
    || (input.project_id !== null && row.project_id !== null && row.project_id !== input.project_id)
    || typeof row.extracted_text !== 'string'
    || row.extracted_text.trim().length === 0)) {
    throw new DocumentContextUnavailableError();
  }

  const projected = assembleRoleScopedContext(
    { role: input.role, user_id: input.user_id },
    { documents: selected },
  ).admissibleFacts.documents;
  if (projected.length !== selected.length) throw new DocumentContextUnavailableError();

  return {
    documents: projected,
    unpromoted_count: projected.filter((row) => row.unpromoted).length,
    facts: projected.map((row) => ({
      id: row.id,
      filename: `${row.unpromoted ? '[UNPROMOTED DRAFT] ' : ''}${row.filename || 'document'}`,
      excerpt: String(row.extracted_text || '').slice(0, 1500),
    })),
  };
}
