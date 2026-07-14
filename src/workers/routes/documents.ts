// documents.ts · POST/GET /api/v1/documents · Stage 2 (source-intake, 260628) · secure document upload.
//
// SECURITY — the wave's hard stop-condition is NO cross-tenant visibility, enforced here:
//   1. an authenticated workspace is REQUIRED (auth.workspace_id), else 401/403;
//   2. the stored workspace_id comes ONLY from auth.workspace_id — NEVER from the request body, so a
//      caller cannot write into another tenant;
//   3. GET lists strictly WHERE workspace_id = auth.workspace_id (the store enforces it), so a caller
//      never sees another tenant's documents.
// Plus: content-type allow-list, a 5 MB cap (also a DB CHECK), honest text-only ingestion (PDF bytes
// stored, extraction deferred — no fabricated text), and a best-effort governed audit event.

import { Hono } from 'hono';
import { neonClient } from '../db/client';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { isAdmissibility, ADMISSIBILITY_VALUES } from '../lib/admissibility';
import { lineageFor } from '../lib/actor-lineage';
import { idempotencyMiddleware } from '../lib/idempotency';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import { insertDocumentRow, listDocumentsRow, updateDocumentAdmissibilityRow, getLatestDocumentVersionRow, sha256Hex } from '../lib/document-store';
import { upsertEventRow } from '../dal/event-store';
import { emitEvent } from '../lib/observability'; // T3/P6

export interface DocumentsEnv extends AuthEnv {
  DATABASE_URL: string;
  IDEMPOTENCY_ENABLED?: string;
}
export type DocumentsVariables = AuthVariables;

export const documentsRoute = new Hono<{ Bindings: DocumentsEnv; Variables: DocumentsVariables }>();
documentsRoute.use('*', idempotencyMiddleware()); // Wave-Y: flag-off ⇒ passthrough

// Production-backed intake types only (matches AddDocsCard's honesty: no method we cannot fulfil).
const ALLOWED_CONTENT_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv', 'application/json', 'application/pdf',
]);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — matches the documents_size_cap CHECK

function isTextType(t: string): boolean {
  return /^text\//i.test(t) || t === 'application/json';
}

// Portable, chunked base64 (no Buffer dependency; safe up to the 5 MB cap; works in Workers + workerd).
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

// POST /api/v1/documents — multipart form-data: "file" (required), optional "project_id".
documentsRoute.post('/documents', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'NO_WORKSPACE', message: 'a workspace is required to add documents' });

    let form: FormData;
    try { form = await ctx.req.formData(); }
    catch { return errorEnvelope(ctx, { status: 400, code: 'BAD_FORM', message: 'multipart form-data with a "file" field is required' }); }

    const file = form.get('file');
    if (!(file instanceof File)) return errorEnvelope(ctx, { status: 400, code: 'NO_FILE', message: 'a "file" field is required' });
    const projectRaw = form.get('project_id');
    const projectId = (typeof projectRaw === 'string' && projectRaw.length > 0) ? projectRaw : null;

    const contentType = file.type || 'application/octet-stream';
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return errorEnvelope(ctx, { status: 415, code: 'UNSUPPORTED_TYPE', message: `unsupported file type: ${contentType}` });
    }
    if (file.size > MAX_BYTES) {
      return errorEnvelope(ctx, { status: 413, code: 'TOO_LARGE', message: `file exceeds the ${MAX_BYTES}-byte limit` });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) return errorEnvelope(ctx, { status: 400, code: 'EMPTY_FILE', message: 'the file is empty' });
    if (bytes.byteLength > MAX_BYTES) return errorEnvelope(ctx, { status: 413, code: 'TOO_LARGE', message: 'file exceeds the limit' });

    // Ingestion: text types → store decoded text (chief-of-staff can read it); binary (PDF) stored
    // bytes-only with extraction deferred. Never fabricate extracted text.
    let extractedText: string | null = null;
    let status = 'stored';
    if (isTextType(contentType)) {
      try { extractedText = new TextDecoder('utf-8', { fatal: false }).decode(bytes).slice(0, 200000); status = 'ingested'; }
      catch { extractedText = null; }
    } else if (contentType === 'application/pdf') {
      // P1.2 (260629) · in-isolate PDF text extraction (unpdf, MIT — CF-Worker-designed: a serverless pdf.js
      // build, no canvas / no worker thread). Born-digital PDFs become answerable by the chief-of-staff chat
      // (Plane C). Dynamic import keeps pdf.js off the cold-start path (loaded only when a PDF is uploaded).
      // Best-effort: a scanned/image-only PDF or a parse failure leaves extracted_text null + status 'stored'
      // (never fabricate — OCR is a separate, owner-gated Container-lane increment per ADR 260628).
      try {
        const { extractText, getDocumentProxy } = await import('unpdf');
        const pdf = await getDocumentProxy(new Uint8Array(bytes));
        const { text } = await extractText(pdf, { mergePages: true });
        const joined = (Array.isArray(text) ? text.join('\n') : String(text || '')).trim();
        if (joined) { extractedText = joined.slice(0, 200000); status = 'ingested'; }
      } catch { extractedText = null; }
    }

    const sql = neonClient(ctx.env.DATABASE_URL);
    const filename = (file.name || 'document').slice(0, 255);
    // A-W5 · version chain: content_hash = SHA-256 of the bytes (the immutable version identity an evidence
    // content_hash matches); if a prior version of this logical document (same project + filename) exists,
    // this upload chains to it (version+1, supersedes_id). Best-effort lookup — a failure yields a fresh v1.
    const contentHash = await sha256Hex(bytes);
    let priorVersion: { id: string; version: number } | null = null;
    try { priorVersion = await getLatestDocumentVersionRow(sql, auth.workspace_id, projectId, filename); }
    catch (err) { console.warn('[documents] prior-version lookup failed (best-effort; fresh v1)', { error: (err as Error)?.message }); }
    const meta = await insertDocumentRow(sql, {
      id: crypto.randomUUID(),
      workspace_id: auth.workspace_id, // FROM AUTH — never the request body
      project_id: projectId,
      filename,
      content_type: contentType,
      size_bytes: bytes.byteLength,
      content_base64: toBase64(bytes),
      extracted_text: extractedText,
      uploaded_by: auth.user_id,
      status,
      content_hash: contentHash,
      version: priorVersion ? priorVersion.version + 1 : 1,
      supersedes_id: priorVersion ? priorVersion.id : null,
    });

    // Governed audit event via the TYPED canonical path (upsertEventRow -> operation_events). source_tool is
    // typed SourceTool, so an invalid value is a COMPILE error — the prior raw INSERT used an unregistered
    // 'document-upload' that silently failed the source_tool CHECK and was swallowed. Best-effort + OBSERVABLE:
    // a failed mirror never blocks the upload, but it is LOGGED (not silently swallowed) — audit loss must be visible.
    let auditEvent: {
      status: 'recorded' | 'failed';
      source_tool: 'document_upload';
      id: string | null;
      created: boolean | null;
      error?: string;
    } = {
      status: 'failed',
      source_tool: 'document_upload',
      id: null,
      created: null,
    };
    try {
      const eventResult = await upsertEventRow(sql, auth.workspace_id, {
        id: crypto.randomUUID(),
        source_tool: 'document_upload',
        status: 'completed',
        summary: `Document added: ${meta.filename}`,
        project_id: projectId,
        visibility: 'internal_workspace',
        occurred_at: new Date().toISOString(),
        // A-W4/P6 · principal-instrument lineage: the uploader is both principal and instrument (a
        // human acting directly under their role authority).
        ...lineageFor(auth),
        request_id: ctx.get('request_id'),
      });
      auditEvent = {
        status: 'recorded',
        source_tool: 'document_upload',
        id: eventResult.id,
        created: eventResult.created,
      };
    } catch (err) {
      auditEvent = {
        status: 'failed',
        source_tool: 'document_upload',
        id: null,
        created: null,
        error: (err as Error)?.message || 'audit event failed',
      };
      console.warn('[documents] governed audit event failed (best-effort; upload still succeeded)', {
        workspace_id: auth.workspace_id, source_tool: 'document_upload', error: (err as Error)?.message,
      });
    }

    emitEvent('document_uploaded', { workspace_id: auth.workspace_id, document_id: (meta as { id?: string })?.id ?? null, audited: Boolean(auditEvent) }); // T3/P6
    return ctx.json({ document: meta, audit_event: auditEvent }, 201);
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
  }
});

// GET /api/v1/documents — THIS workspace's documents only (metadata; tenant-scoped in the store).
documentsRoute.get('/documents', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return ctx.json(withDataClass({ documents: [] }, 'live'));
    // 046 · route the document LIST through the RLS-subject client when configured (else owner → identical).
    const sql = neonClient(ctx.env.XLOOOP_RLS_APP_DATABASE_URL || ctx.env.DATABASE_URL);
    const docs = await listDocumentsRow(sql, auth.workspace_id);
    return ctx.json(withDataClass({ documents: docs }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
  }
});

// PATCH /api/v1/documents/:id/admissibility — M6 · govern whether a document may enter the chief-of-staff's
// context (owner/operator only). Body: { admissibility: 'visible'|'excluded'|'candidate'|'approved' }. The
// grounding read admits only 'approved'/'visible'; setting 'excluded'/'candidate' drops it from context.
documentsRoute.patch('/documents/:id/admissibility', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'NO_WORKSPACE', message: 'a workspace is required' });
    if (auth.role !== 'owner' && auth.role !== 'operator') {
      return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: `role ${auth.role} cannot set document admissibility (requires owner or operator)` });
    }
    const id = ctx.req.param('id');
    if (!id) return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'document id required' });
    const body = await ctx.req.json().catch(() => null) as { admissibility?: unknown } | null;
    if (!body || !isAdmissibility(body.admissibility)) {
      return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: `admissibility must be one of: ${ADMISSIBILITY_VALUES.join(', ')}` });
    }
    const sql = neonClient(ctx.env.XLOOOP_RLS_APP_DATABASE_URL || ctx.env.DATABASE_URL);
    let doc;
    try {
      doc = await updateDocumentAdmissibilityRow(sql, auth.workspace_id, id, body.admissibility);
    } catch (err) {
      // 049 not applied yet → the column is absent. Surface a clear, non-5xx signal instead of a raw 500.
      if (/admissibility.*does not exist/i.test(String((err as Error)?.message || ''))) {
        return errorEnvelope(ctx, { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'document admissibility is not enabled yet (migration 049 pending)' });
      }
      throw err;
    }
    if (!doc) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `document ${id} not found` });
    // Best-effort governed audit event on the customer-visible spine (admissibility is a governance act).
    try {
      await upsertEventRow(sql, auth.workspace_id, {
        id: crypto.randomUUID(),
        source_tool: 'document_upload',
        status: 'completed',
        summary: `Document admissibility set to ${body.admissibility}: ${doc.filename}`.slice(0, 512),
        project_id: doc.project_id,
        visibility: 'internal_workspace',
        occurred_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[documents] admissibility audit event failed (best-effort)', { workspace_id: auth.workspace_id, error: (err as Error)?.message });
    }
    return ctx.json(withDataClass({ document: doc }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, { status: 500, code: 'INTERNAL_ERROR', message: (err as Error).message });
  }
});
