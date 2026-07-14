// document-store.ts · Stage 2 (source-intake, 260628) · tenant-scoped document storage (Neon bytea).
//
// SECURITY (the wave's hard stop-condition: NO cross-tenant visibility): every function takes the
// workspace_id explicitly and every query is scoped `WHERE workspace_id = ${workspaceId}`. The ROUTE
// passes the workspace_id from the authenticated session (auth.workspace_id) and NEVER from the request
// body, so a document is only ever written/read within its own tenant. Single-row reads scope on BOTH
// id AND workspace_id, so a guessed/leaked id from another tenant returns nothing.
//
// Bytea is written via decode(base64,'base64') so binary survives the Neon HTTP driver reliably.

import type { Sql } from '../db/client';
// 046 · document LIST reads run inside the workspace-GUC transaction so the RLS-subject client
// (passed by the route when XLOOOP_RLS_APP_DATABASE_URL is set) is DB-filtered. Byte-identical for the
// owner client (bypasses RLS; the WHERE workspace_id still scopes).
import { withWorkspaceRlsContext } from '../dal/operational-spine-store';
import type { Admissibility } from './admissibility';

export interface DocumentMeta {
  id: string;
  workspace_id: string;
  project_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  extracted_text: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  status: string;
  // M6 (049) · AI-context admissibility. Degrade-safe: pre-migration reads default to 'approved' so the
  // grounding read never silently loses documents before 049 is applied.
  admissibility: Admissibility;
  // A-W5 (051) · version chain / evidence integrity. content_hash = SHA-256 (hex) of the content bytes (the
  // immutable version identity an evidence content_hash matches); version = 1-based within a supersedes
  // chain; supersedes_id = the prior version's document id. Degrade-safe: pre-051 rows read null/1/null.
  content_hash: string | null;
  version: number;
  supersedes_id: string | null;
}

export interface InsertDocumentInput {
  id: string;
  workspace_id: string;     // ALWAYS the authenticated session's workspace (never from the request body)
  project_id: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  content_base64: string;   // file bytes, base64 — decoded to bytea in SQL
  extracted_text: string | null;
  uploaded_by: string | null;
  status: string;
  // A-W5 (051) · version chain — content_hash computed by the route (SHA-256 of the bytes); version +
  // supersedes_id resolved by the route from any prior same-filename document in the project.
  content_hash?: string | null;
  version?: number;
  supersedes_id?: string | null;
}

export async function insertDocumentRow(sql: Sql, doc: InsertDocumentInput): Promise<DocumentMeta> {
  // A-W5 · degrade-safe insert: the full column set includes admissibility (049) + the version-chain
  // columns (051). If EITHER migration is not applied yet, fall back to the legacy insert — a document
  // upload must never fail on a migrate→deploy ordering slip. content_hash is the SHA-256 the route
  // computed; version/supersedes_id come from the route's prior-version lookup (default 1/null).
  try {
    const rows = (await sql`
      INSERT INTO documents (id, workspace_id, project_id, filename, content_type, size_bytes, content, extracted_text, uploaded_by, status, content_hash, version, supersedes_id)
      VALUES (${doc.id}, ${doc.workspace_id}, ${doc.project_id}, ${doc.filename}, ${doc.content_type}, ${doc.size_bytes}, decode(${doc.content_base64}, 'base64'), ${doc.extracted_text}, ${doc.uploaded_by}, ${doc.status}, ${doc.content_hash ?? null}, ${doc.version ?? 1}, ${doc.supersedes_id ?? null})
      RETURNING id, workspace_id, project_id, filename, content_type, size_bytes, extracted_text, uploaded_by, uploaded_at, status, admissibility, content_hash, version, supersedes_id
    `) as Record<string, unknown>[];
    return withDocumentDefaults(rows[0]);
  } catch (err) {
    if (!isMissingDocumentColumn(err)) throw err;
  }
  const rows = (await sql`
    INSERT INTO documents (id, workspace_id, project_id, filename, content_type, size_bytes, content, extracted_text, uploaded_by, status)
    VALUES (${doc.id}, ${doc.workspace_id}, ${doc.project_id}, ${doc.filename}, ${doc.content_type}, ${doc.size_bytes}, decode(${doc.content_base64}, 'base64'), ${doc.extracted_text}, ${doc.uploaded_by}, ${doc.status})
    RETURNING id, workspace_id, project_id, filename, content_type, size_bytes, extracted_text, uploaded_by, uploaded_at, status
  `) as Record<string, unknown>[];
  return withDocumentDefaults(rows[0]);
}

// A-W5 · SHA-256 (hex) of the document bytes — the version identity. Pure; used by the upload route.
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: crypto.subtle.digest wants a BufferSource whose backing
  // buffer is an ArrayBuffer, and a plain Uint8Array is typed over ArrayBufferLike (could be a
  // SharedArrayBuffer). `new Uint8Array(bytes)` yields a Uint8Array<ArrayBuffer> — sound, no assertion.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// True iff a "column does not exist" error names one of the additive document columns (admissibility from
// 049, or the 051 version-chain columns) → that migration is not applied yet. Any other error re-throws.
function isMissingDocumentColumn(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  return /column\s+"?(admissibility|content_hash|version|supersedes_id)"?.*does not exist/i.test(msg);
}

// Default a row missing the additive columns (behavior-preserving; see 049/051 headers). This is the
// ONE typed boundary from a raw driver row to DocumentMeta: the SELECTs return exactly the DocumentMeta
// columns (plus these four, defaulted here for the legacy/pre-migration shape), so the single
// `as unknown as DocumentMeta` here is the trusted DB-row→entity conversion — call sites stay cast-free.
function withDocumentDefaults(r: Record<string, unknown>): DocumentMeta {
  return {
    ...r,
    admissibility: (r.admissibility as Admissibility) ?? 'approved',
    content_hash: (r.content_hash as string | null) ?? null,
    version: (r.version as number) ?? 1,
    supersedes_id: (r.supersedes_id as string | null) ?? null,
  } as unknown as DocumentMeta;
}

// List a workspace's documents — METADATA ONLY (never returns the bytea content). The WHERE is the
// cross-tenant guard. M6: selects admissibility; degrades to the legacy shape (admissibility='approved')
// if 049 is not applied yet, so grounding + the list never break during the migrate→deploy window.
export async function listDocumentsRow(sql: Sql, workspaceId: string, limit = 50): Promise<DocumentMeta[]> {
  const lim = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  try {
    const [rows] = await withWorkspaceRlsContext<[Record<string, unknown>[]]>(sql, workspaceId, (tx) => [
      tx`
      SELECT id, workspace_id, project_id, filename, content_type, size_bytes, extracted_text, uploaded_by, uploaded_at, status, admissibility, content_hash, version, supersedes_id
      FROM documents
      WHERE workspace_id = ${workspaceId}
      ORDER BY uploaded_at DESC
      LIMIT ${lim}
    `,
    ], { readOnly: true });
    return rows.map(withDocumentDefaults);
  } catch (err) {
    if (!isMissingDocumentColumn(err)) throw err;
    const [rows] = await withWorkspaceRlsContext<[Record<string, unknown>[]]>(sql, workspaceId, (tx) => [
      tx`
      SELECT id, workspace_id, project_id, filename, content_type, size_bytes, extracted_text, uploaded_by, uploaded_at, status
      FROM documents
      WHERE workspace_id = ${workspaceId}
      ORDER BY uploaded_at DESC
      LIMIT ${lim}
    `,
    ], { readOnly: true });
    return rows.map(withDocumentDefaults);
  }
}

// Single document read — scoped on id AND workspace_id, so a cross-tenant id resolves to null.
export async function getDocumentRow(sql: Sql, workspaceId: string, id: string): Promise<DocumentMeta | null> {
  try {
    const [rows] = await withWorkspaceRlsContext<[Record<string, unknown>[]]>(sql, workspaceId, (tx) => [
      tx`
      SELECT id, workspace_id, project_id, filename, content_type, size_bytes, extracted_text, uploaded_by, uploaded_at, status, admissibility, content_hash, version, supersedes_id
      FROM documents
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      LIMIT 1
    `,
    ], { readOnly: true });
    return rows[0] ? withDocumentDefaults(rows[0]) : null;
  } catch (err) {
    if (!isMissingDocumentColumn(err)) throw err;
    const [rows] = await withWorkspaceRlsContext<[Record<string, unknown>[]]>(sql, workspaceId, (tx) => [
      tx`
      SELECT id, workspace_id, project_id, filename, content_type, size_bytes, extracted_text, uploaded_by, uploaded_at, status
      FROM documents
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      LIMIT 1
    `,
    ], { readOnly: true });
    return rows[0] ? withDocumentDefaults(rows[0]) : null;
  }
}

// A-W5 · find the latest version of a logical document (same workspace+project+filename) so a re-upload
// can chain to it (version+1, supersedes_id). "Same logical document" = identical filename within the same
// project. Degrade-safe: if 051's version column is absent, returns null → the upload is a fresh v1, no chain.
export async function getLatestDocumentVersionRow(
  sql: Sql,
  workspaceId: string,
  projectId: string | null,
  filename: string,
): Promise<{ id: string; version: number } | null> {
  try {
    const [rows] = await withWorkspaceRlsContext<[Array<{ id: string; version: number }>]>(sql, workspaceId, (tx) => [
      tx`
      SELECT id, version
      FROM documents
      WHERE workspace_id = ${workspaceId}
        AND filename = ${filename}
        AND (${projectId}::text IS NULL AND project_id IS NULL OR project_id = ${projectId}::text)
        AND status <> 'archived'
      ORDER BY version DESC, uploaded_at DESC
      LIMIT 1
    `,
    ], { readOnly: true });
    return rows[0] ?? null;
  } catch (err) {
    if (!isMissingDocumentColumn(err)) throw err;
    return null; // pre-051: no version chain
  }
}

// M6 · set a document's admissibility (owner/operator gate at the route). Scoped on id AND workspace_id
// (cross-tenant writes resolve to null). Runs inside the workspace-GUC tx so the RLS-subject client is
// DB-filtered. Requires 049 applied — the caller surfaces a clear error if the column is absent.
export async function updateDocumentAdmissibilityRow(
  sql: Sql,
  workspaceId: string,
  id: string,
  admissibility: Admissibility,
): Promise<DocumentMeta | null> {
  const [rows] = await withWorkspaceRlsContext<[Record<string, unknown>[]]>(sql, workspaceId, (tx) => [
    tx`
    UPDATE documents
    SET admissibility = ${admissibility}
    WHERE id = ${id} AND workspace_id = ${workspaceId}
    RETURNING id, workspace_id, project_id, filename, content_type, size_bytes, extracted_text, uploaded_by, uploaded_at, status, admissibility
  `,
  ]);
  // withDocumentDefaults fills content_hash/version/supersedes_id (not needed on an admissibility PATCH;
  // keeping them out of this RETURNING keeps it safe if 051 lags 049 during a migrate window).
  return rows[0] ? withDocumentDefaults(rows[0]) : null;
}

// NOTE (P4 · 260629): the document audit event is no longer a bespoke raw INSERT here. It moved to the TYPED
// canonical path — documents.ts now calls `upsertEventRow(sql, workspaceId, {source_tool:'document_upload', ...})`
// from dal/event-store.ts. The old raw INSERT used an unregistered source_tool ('document-upload') that
// silently failed the source_tool CHECK; routing through the typed event-store path makes source_tool a
// compile-checked SourceTool. The `verify:no-raw-operation-events-insert` gate now forbids re-adding a raw
// governed-event INSERT here (outside the canonical DAL stores). See docs/engineering/INTAKE_CONTRACT.md §V3/V4.
