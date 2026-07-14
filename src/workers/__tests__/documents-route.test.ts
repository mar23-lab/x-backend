// documents-route.test.ts · Stage 2 source-intake · SECURITY tests for POST/GET /api/v1/documents.
//
// The wave's hard stop-condition is NO cross-tenant visibility. These lock it behaviorally:
//   - the stored workspace comes from auth.workspace_id, NEVER the request body (no cross-tenant write);
//   - GET lists only the caller's workspace (a doc in A is invisible to B);
//   - auth + workspace are required; content-type is allow-listed; the 5 MB cap is enforced.
//
// The document-store is mocked with an in-memory map KEYED BY workspace_id, so "list as B returns
// nothing" is a real behavioral assertion of the route passing the correct (auth) workspace.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const STORE = new Map<string, any[]>();
const mocks = vi.hoisted(() => ({
  upsertEventRow: vi.fn(async () => ({ id: 'evt_doc_test', created: true })),
}));

vi.mock('../lib/document-store', () => ({
  insertDocumentRow: vi.fn(async (_sql: unknown, doc: any) => {
    const meta = {
      id: doc.id, workspace_id: doc.workspace_id, project_id: doc.project_id, filename: doc.filename,
      content_type: doc.content_type, size_bytes: doc.size_bytes, extracted_text: doc.extracted_text,
      uploaded_by: doc.uploaded_by, uploaded_at: '2026-06-28T00:00:00Z', status: doc.status,
    };
    const arr = STORE.get(doc.workspace_id) ?? [];
    arr.push(meta);
    STORE.set(doc.workspace_id, arr);
    return meta;
  }),
  listDocumentsRow: vi.fn(async (_sql: unknown, workspaceId: string) => (STORE.get(workspaceId) ?? []).slice()),
  getDocumentRow: vi.fn(async (_sql: unknown, workspaceId: string, id: string) =>
    (STORE.get(workspaceId) ?? []).find((d) => d.id === id) ?? null),
  // A-W5 (migration 051 version chain): the POST handler now awaits sha256Hex(bytes) for content_hash and
  // getLatestDocumentVersionRow for the version chain. vi.mock replaces the WHOLE module, so these MUST be
  // present or they resolve to undefined and the handler throws 500. sha256Hex is on the critical path
  // (not try/caught); getLatestDocumentVersionRow is best-effort (null ⇒ fresh v1).
  sha256Hex: vi.fn(async () => 'a'.repeat(64)),
  getLatestDocumentVersionRow: vi.fn(async () => null),
  updateDocumentAdmissibilityRow: vi.fn(async () => null),
}));

// P4 (260629): the document audit event now routes through the typed canonical upsertEventRow (event-store),
// not a bespoke document-store raw INSERT. Mock it so the route's best-effort mirror doesn't hit real SQL.
vi.mock('../dal/event-store', () => ({
  upsertEventRow: mocks.upsertEventRow,
}));

import { documentsRoute } from '../routes/documents';

function appFor(workspace_id: string, user_id = 'u1') {
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('auth', { user_id, workspace_id } as never); await next(); });
  app.route('/api/v1', documentsRoute);
  return app;
}
// Format-valid URL so neon() doesn't throw on construction; the store is mocked so it never connects.
const ENV = { DATABASE_URL: 'postgresql://u:p@host.tld/db' } as never;
const URL = 'http://local/api/v1/documents';

// Build an explicit Request so the multipart boundary/content-type is set for ctx.req.formData().
function uploadReq(text: string, name = 'note.txt', type = 'text/plain', extra: Record<string, string> = {}): Request {
  const fd = new FormData();
  fd.append('file', new File([text], name, { type }));
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return new Request(URL, { method: 'POST', body: fd });
}
const listReq = () => new Request(URL, { method: 'GET' });

beforeEach(() => {
  STORE.clear();
  mocks.upsertEventRow.mockReset();
  mocks.upsertEventRow.mockResolvedValue({ id: 'evt_doc_test', created: true });
});

describe('POST/GET /documents · tenant isolation + validation', () => {
  it('stores under the AUTH workspace and ingests text content', async () => {
    const res = await appFor('ws-A').request(uploadReq('hello world', 'a.txt'), undefined, ENV);
    expect(res.status).toBe(201);
    const j = (await res.json()) as any;
    expect(j.document.workspace_id).toBe('ws-A');
    expect(j.document.extracted_text).toBe('hello world');
    expect(j.document.status).toBe('ingested');
    expect(j.audit_event).toEqual({
      status: 'recorded',
      source_tool: 'document_upload',
      id: 'evt_doc_test',
      created: true,
    });
  });

  it('still stores the document but reports audit_event failed when the governed event mirror fails', async () => {
    mocks.upsertEventRow.mockRejectedValueOnce(new Error('source_tool check failed'));
    const res = await appFor('ws-A').request(uploadReq('hello world', 'a.txt'), undefined, ENV);
    expect(res.status).toBe(201);
    const j = (await res.json()) as any;
    expect(j.document.workspace_id).toBe('ws-A');
    expect(j.document.status).toBe('ingested');
    expect(j.audit_event.status).toBe('failed');
    expect(j.audit_event.source_tool).toBe('document_upload');
    expect(j.audit_event.error).toContain('source_tool check failed');
  });

  it('a request body CANNOT override the workspace (no cross-tenant write)', async () => {
    await appFor('ws-A').request(uploadReq('x', 'a.txt', 'text/plain', { workspace_id: 'ws-B' }), undefined, ENV);
    expect((STORE.get('ws-A') ?? []).length).toBe(1); // landed in the AUTH workspace
    expect(STORE.get('ws-B')).toBeUndefined();         // NOT the body's attempt
  });

  it('GET lists ONLY the caller workspace — a doc in A is invisible to B', async () => {
    await appFor('ws-A').request(uploadReq('secret', 'a.txt'), undefined, ENV);
    const aList = (await (await appFor('ws-A').request(listReq(), undefined, ENV)).json()) as any;
    const bList = (await (await appFor('ws-B').request(listReq(), undefined, ENV)).json()) as any;
    expect(aList.documents.length).toBe(1);
    expect(bList.documents.length).toBe(0); // cross-tenant isolation
  });

  it('403 when the session has no workspace', async () => {
    const res = await appFor('').request(uploadReq('x'), undefined, ENV);
    expect(res.status).toBe(403);
  });

  it('415 unsupported content type', async () => {
    const res = await appFor('ws-A').request(uploadReq('x', 'e.exe', 'application/x-msdownload'), undefined, ENV);
    expect(res.status).toBe(415);
  });

  it('413 over the 5 MB cap', async () => {
    const big = 'a'.repeat(5 * 1024 * 1024 + 10);
    const res = await appFor('ws-A').request(uploadReq(big, 'big.txt'), undefined, ENV);
    expect(res.status).toBe(413);
  });

  it('400 when no file field is present', async () => {
    const res = await appFor('ws-A').request(new Request(URL, { method: 'POST', body: new FormData() }), undefined, ENV);
    expect(res.status).toBe(400);
  });
});
