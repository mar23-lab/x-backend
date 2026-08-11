// documents.ts · POST/GET /api/v1/documents · Stage 2 (source-intake, 260628) · secure document upload.
//
// SECURITY — the wave's hard stop-condition is NO cross-tenant visibility, enforced here:
//   1. an authenticated workspace is REQUIRED (auth.workspace_id), else 401/403;
//   2. the stored workspace_id comes ONLY from auth.workspace_id — NEVER from the request body, so a
//      caller cannot write into another tenant;
//   3. GET lists strictly WHERE workspace_id = auth.workspace_id (the store enforces it), so a caller
//      never sees another tenant's documents.
// Plus: content-type allow-list, a 5 MB cap (also a DB CHECK), honest text-only ingestion (PDF bytes
// stored, extraction deferred — no fabricated text), and fail-closed authority receipts.

import { Hono } from 'hono';
import { neonClient } from '../db/client';
import { resolveRlsSql } from '../db/rls-connection';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { isAdmissibility, ADMISSIBILITY_VALUES } from '../lib/admissibility';
import { idempotencyMiddleware } from '../lib/idempotency';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import { insertDocumentWithAuthorityRow, listDocumentsRow, updateDocumentAdmissibilityWithAuthorityRow, getLatestDocumentVersionRow, sha256Hex } from '../dal/document-store';
import { emitEvent } from '../lib/observability'; // T3/P6
import {
  convertDocumentWithMarkitdown,
  markitdownEnabled,
  type CapabilityReceipt,
  type ExternalCapabilityAdapterEnv,
} from '../services/external-capability-adapter';

export interface DocumentsEnv extends AuthEnv, ExternalCapabilityAdapterEnv {
  DATABASE_URL: string;
  IDEMPOTENCY_ENABLED?: string;
}
export type DocumentsVariables = AuthVariables;

export const documentsRoute = new Hono<{ Bindings: DocumentsEnv; Variables: DocumentsVariables }>();
documentsRoute.use('*', idempotencyMiddleware()); // Wave-Y: flag-off ⇒ passthrough

// Production-backed intake types only (matches AddDocsCard's honesty: no method we cannot fulfil).
const CORE_CONTENT_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv', 'application/json', 'application/pdf',
]);
const MARKITDOWN_CONTENT_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
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
    const markitdownAvailable = markitdownEnabled(ctx.env);
    if (!CORE_CONTENT_TYPES.has(contentType) && !(markitdownAvailable && MARKITDOWN_CONTENT_TYPES.has(contentType))) {
      return errorEnvelope(ctx, { status: 415, code: 'UNSUPPORTED_TYPE', message: `unsupported file type: ${contentType}` });
    }
    if (file.size > MAX_BYTES) {
      return errorEnvelope(ctx, { status: 413, code: 'TOO_LARGE', message: `file exceeds the ${MAX_BYTES}-byte limit` });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) return errorEnvelope(ctx, { status: 400, code: 'EMPTY_FILE', message: 'the file is empty' });
    if (bytes.byteLength > MAX_BYTES) return errorEnvelope(ctx, { status: 413, code: 'TOO_LARGE', message: 'file exceeds the limit' });

    const filename = (file.name || 'document').slice(0, 255);
    const contentBase64 = toBase64(bytes);
    const contentHash = await sha256Hex(bytes);

    // Ingestion: native text stays in-isolate. Binary conversion enters only through the private,
    // no-egress capability service binding. Office formats are accepted only when that binding and
    // tenant flag are both active, so the API never reports a fake-success stored document.
    let extractedText: string | null = null;
    let status = 'stored';
    let conversionReceipt: CapabilityReceipt | null = null;
    if (isTextType(contentType)) {
      try { extractedText = new TextDecoder('utf-8', { fatal: false }).decode(bytes).slice(0, 200000); status = 'ingested'; }
      catch { extractedText = null; }
    } else if (markitdownAvailable && MARKITDOWN_CONTENT_TYPES.has(contentType)) {
      const converted = await convertDocumentWithMarkitdown({
        env: ctx.env,
        workspace_id: auth.workspace_id,
        request_id: ctx.get('request_id') || null,
        filename,
        content_type: contentType,
        content_base64: contentBase64,
        source_hash: contentHash,
      });
      extractedText = converted.extracted_text.slice(0, 200000);
      conversionReceipt = converted.receipt;
      status = 'ingested';
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
    // A7 step 3 (260731) · the prior-version LOOKUP is a workspace-scoped READ, so it belongs on the
    // RLS-subject client — the same client the enumeration surface below already uses, and what
    // migration 046 said this surface should use. The WRITE on the next statement stays on the owner
    // connection deliberately: insertDocumentWithAuthorityRow touches more than `documents`, and
    // moving writes is step 3's later half, not this slice.
    //
    // Provably behaviour-identical rather than hoped: getLatestDocumentVersionRow reads ONLY
    // `documents`; that table is RLS-enabled with exactly one policy,
    // `workspace_id = xlooop_rls_workspace_id()`; withWorkspaceRlsContext sets that GUC to the same
    // workspace_id the query already filters on. Same predicate, same rows. The `|| DATABASE_URL`
    // fallback matches the sibling call sites so an environment without the RLS secret bound keeps
    // working instead of silently reading zero rows.
    const readSql = resolveRlsSql(ctx.env, neonClient(ctx.env.DATABASE_URL));
    // A-W5 · version chain: content_hash = SHA-256 of the bytes (the immutable version identity an evidence
    // content_hash matches); if a prior version of this logical document (same project + filename) exists,
    // this upload chains to it (version+1, supersedes_id). Best-effort lookup — a failure yields a fresh v1.
    let priorVersion: { id: string; version: number } | null = null;
    try { priorVersion = await getLatestDocumentVersionRow(readSql, auth.workspace_id, projectId, filename); }
    catch (err) { console.warn('[documents] prior-version lookup failed (best-effort; fresh v1)', { error: (err as Error)?.message }); }
    const write = await insertDocumentWithAuthorityRow(sql, {
      id: crypto.randomUUID(),
      workspace_id: auth.workspace_id, // FROM AUTH — never the request body
      project_id: projectId,
      filename,
      content_type: contentType,
      size_bytes: bytes.byteLength,
      content_base64: contentBase64,
      extracted_text: extractedText,
      uploaded_by: auth.user_id,
      status,
      content_hash: contentHash,
      version: priorVersion ? priorVersion.version + 1 : 1,
      supersedes_id: priorVersion ? priorVersion.id : null,
    }, {
      operation_event_id: crypto.randomUUID(),
      projection_outbox_id: crypto.randomUUID(),
      request_id: ctx.get('request_id') || null,
      capability_receipt: conversionReceipt,
    });
    emitEvent('document_uploaded', {
      workspace_id: auth.workspace_id,
      document_id: write.document.id,
      operation_event_id: write.operation_event_id,
      audited: true,
    }); // T3/P6
    return ctx.json({
      document: write.document,
      receipt_id: write.receipt_id,
      operation_event_id: write.operation_event_id,
      audit_event_id: write.audit_event_id,
      projection_outbox_id: write.projection_outbox_id,
      conversion: conversionReceipt,
      audit_event: {
        status: 'recorded',
        source_tool: 'document_upload',
        id: write.operation_event_id,
        created: true,
      },
    }, 201);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /api/v1/documents — THIS workspace's documents only (metadata; tenant-scoped in the store).
documentsRoute.get('/documents', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return ctx.json(withDataClass({ documents: [] }, 'live'));
    // 046 · route the document LIST through the RLS-subject client when configured (else owner → identical).
    const sql = resolveRlsSql(ctx.env, neonClient(ctx.env.DATABASE_URL));
    const docs = await listDocumentsRow(sql, auth.workspace_id);
    return ctx.json(withDataClass({ documents: docs }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
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
    // Writes use the owner connection: xlooop_app intentionally has document SELECT only.
    // Tenant authority remains the authenticated workspace predicate inside the atomic CTE.
    const sql = neonClient(ctx.env.DATABASE_URL);
    let write;
    try {
      write = await updateDocumentAdmissibilityWithAuthorityRow(
        sql,
        auth.workspace_id,
        id,
        body.admissibility,
        {
          actor_user_id: auth.user_id,
          operation_event_id: crypto.randomUUID(),
          projection_outbox_id: crypto.randomUUID(),
          request_id: ctx.get('request_id') || null,
        },
      );
    } catch (err) {
      // 049 not applied yet → the column is absent. Surface a clear, non-5xx signal instead of a raw 500.
      if (/admissibility.*does not exist/i.test(String((err as Error)?.message || ''))) {
        return errorEnvelope(ctx, { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'document admissibility is not enabled yet (migration 049 pending)' });
      }
      throw err;
    }
    if (!write) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: `document ${id} not found` });
    return ctx.json(withDataClass({
      document: write.document,
      receipt_id: write.receipt_id,
      operation_event_id: write.operation_event_id,
      audit_event_id: write.audit_event_id,
      projection_outbox_id: write.projection_outbox_id,
    }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
