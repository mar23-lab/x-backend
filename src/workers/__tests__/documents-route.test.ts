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
  insertDocumentWithAuthorityRow: vi.fn(),
  updateDocumentAdmissibilityWithAuthorityRow: vi.fn(),
  neonClient: vi.fn(() => ({})),
  convertDocumentWithMarkitdown: vi.fn(),
}));

vi.mock('../db/client', () => ({ neonClient: mocks.neonClient }));

vi.mock('../services/external-capability-adapter', () => ({
  markitdownEnabled: vi.fn(async (env: Record<string, unknown>, workspaceId: string) =>
    env.MARKITDOWN_ADAPTER_ENABLED === 'true'
    && env.EXTERNAL_CAPABILITY_TENANT_REFS === workspaceId
    && Boolean(env.EXTERNAL_CAPABILITY_ADAPTER)),
  convertDocumentWithMarkitdown: mocks.convertDocumentWithMarkitdown,
}));

vi.mock('../dal/document-store', () => ({
  insertDocumentWithAuthorityRow: mocks.insertDocumentWithAuthorityRow,
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
  updateDocumentAdmissibilityWithAuthorityRow: mocks.updateDocumentAdmissibilityWithAuthorityRow,
}));

import { documentsRoute } from '../routes/documents';

function appFor(workspace_id: string, user_id = 'u1', role = 'owner') {
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('auth', { user_id, workspace_id, role } as never); await next(); });
  app.route('/api/v1', documentsRoute);
  return app;
}
// Format-valid URL so neon() doesn't throw on construction; the store is mocked so it never connects.
const ENV = {
  DATABASE_URL: 'postgresql://owner:p@host.tld/db',
  XLOOOP_RLS_APP_DATABASE_URL: 'postgresql://app:p@host.tld/db',
} as never;
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
  mocks.insertDocumentWithAuthorityRow.mockReset();
  mocks.updateDocumentAdmissibilityWithAuthorityRow.mockReset();
  mocks.neonClient.mockClear();
  mocks.convertDocumentWithMarkitdown.mockReset();
  mocks.convertDocumentWithMarkitdown.mockResolvedValue({
    extracted_text: 'Converted Office document',
    source_spans: [{ start: 0, end: 25, source_ref: `sha256:${'a'.repeat(64)}` }],
    receipt: {
      capability: 'markitdown', tool_version: '0.1.7', source_hash: 'a'.repeat(64),
      output_hash: 'b'.repeat(64), latency_ms: 12, replayable: true,
    },
  });
  mocks.insertDocumentWithAuthorityRow.mockImplementation(async (_sql: unknown, doc: any) => {
    const meta = {
      id: doc.id, workspace_id: doc.workspace_id, project_id: doc.project_id, filename: doc.filename,
      content_type: doc.content_type, size_bytes: doc.size_bytes, extracted_text: doc.extracted_text,
      uploaded_by: doc.uploaded_by, uploaded_at: '2026-06-28T00:00:00Z', status: doc.status,
      admissibility: 'approved', content_hash: doc.content_hash, version: doc.version, supersedes_id: doc.supersedes_id,
    };
    const arr = STORE.get(doc.workspace_id) ?? [];
    arr.push(meta);
    STORE.set(doc.workspace_id, arr);
    return {
      document: meta,
      receipt_id: `document-upload:${doc.id}:audit_doc_test`,
      operation_event_id: 'evt_doc_test',
      audit_event_id: 'audit_doc_test',
      projection_outbox_id: 'outbox_doc_test',
    };
  });
  mocks.updateDocumentAdmissibilityWithAuthorityRow.mockImplementation(
    async (_sql: unknown, workspaceId: string, id: string, admissibility: string) => {
      const doc = (STORE.get(workspaceId) ?? []).find((candidate) => candidate.id === id);
      if (!doc) return null;
      doc.admissibility = admissibility;
      return {
        document: doc,
        receipt_id: `document-admissibility:${id}:audit_adm_test`,
        operation_event_id: 'evt_adm_test',
        audit_event_id: 'audit_adm_test',
        projection_outbox_id: 'outbox_adm_test',
      };
    },
  );
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
    expect(j.receipt_id).toContain('document-upload:');
    expect(j.operation_event_id).toBe('evt_doc_test');
    expect(j.audit_event_id).toBe('audit_doc_test');
    expect(j.projection_outbox_id).toBe('outbox_doc_test');
  });

  it('fails closed and stores nothing when authority lineage cannot be written', async () => {
    mocks.insertDocumentWithAuthorityRow.mockRejectedValueOnce(new Error('outbox write failed'));
    const res = await appFor('ws-A').request(uploadReq('hello world', 'a.txt'), undefined, ENV);
    expect(res.status).toBe(500);
    expect(STORE.get('ws-A')).toBeUndefined();
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

  it('keeps Office types unavailable while the private adapter flag is off', async () => {
    const res = await appFor('ws-A').request(
      uploadReq('docx bytes', 'brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      undefined,
      ENV,
    );
    expect(res.status).toBe(415);
    expect(mocks.convertDocumentWithMarkitdown).not.toHaveBeenCalled();
  });

  it('ingests Office types only through the private adapter and returns its replay receipt', async () => {
    const adapterEnv = {
      ...ENV,
      MARKITDOWN_ADAPTER_ENABLED: 'true',
      EXTERNAL_CAPABILITY_TENANT_REFS: 'ws-A',
      EXTERNAL_CAPABILITY_ADAPTER: { fetch: vi.fn() },
    } as never;
    const res = await appFor('ws-A').request(
      uploadReq('docx bytes', 'brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      undefined,
      adapterEnv,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.document.extracted_text).toBe('Converted Office document');
    expect(body.conversion).toMatchObject({ capability: 'markitdown', replayable: true });
    expect(mocks.convertDocumentWithMarkitdown).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: 'ws-A',
      filename: 'brief.docx',
      source_hash: 'a'.repeat(64),
    }));
  });

  it('does not let the MarkItDown flag take over the native PDF lane', async () => {
    const adapterEnv = {
      ...ENV,
      MARKITDOWN_ADAPTER_ENABLED: 'true',
      EXTERNAL_CAPABILITY_TENANT_REFS: 'ws-A',
      EXTERNAL_CAPABILITY_ADAPTER: { fetch: vi.fn() },
    } as never;
    const res = await appFor('ws-A').request(
      uploadReq('not a real pdf', 'brief.pdf', 'application/pdf'),
      undefined,
      adapterEnv,
    );
    expect(res.status).toBe(201);
    expect(mocks.convertDocumentWithMarkitdown).not.toHaveBeenCalled();
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

describe('PATCH /documents/:id/admissibility · fail-closed authority', () => {
  it('returns the durable event, audit, and outbox receipt', async () => {
    const upload = await appFor('ws-A').request(uploadReq('govern me', 'a.txt'), undefined, ENV);
    const id = ((await upload.json()) as any).document.id;
    const res = await appFor('ws-A').request(
      new Request(`${URL}/${id}/admissibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ admissibility: 'excluded' }),
      }),
      undefined,
      ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.document.admissibility).toBe('excluded');
    expect(body.receipt_id).toBe(`document-admissibility:${id}:audit_adm_test`);
    expect(body.operation_event_id).toBe('evt_adm_test');
    expect(body.audit_event_id).toBe('audit_adm_test');
    expect(body.projection_outbox_id).toBe('outbox_adm_test');
    expect(mocks.neonClient).toHaveBeenCalledWith('postgresql://owner:p@host.tld/db');
  });

  it('does not report success when the authority transaction fails', async () => {
    mocks.updateDocumentAdmissibilityWithAuthorityRow.mockRejectedValueOnce(new Error('audit write failed'));
    const res = await appFor('ws-A').request(
      new Request(`${URL}/doc-1/admissibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ admissibility: 'excluded' }),
      }),
      undefined,
      ENV,
    );
    expect(res.status).toBe(500);
  });
});
