// request-guards.test.ts — locks the ingress content-type contract (260630).
// Regression guard for the document-upload bug: the global requestGuards middleware enforced
// Content-Type: application/json on ALL mutating requests, which rejected the multipart/form-data
// file upload (POST /api/v1/documents) with 415 before the route ran. multipart MUST pass.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requestGuards } from '../middleware/request-guards';

function appWithGuard() {
  const app = new Hono();
  app.use('*', requestGuards());
  app.post('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('requestGuards — content-type enforcement on mutations', () => {
  it('accepts application/json', async () => {
    const res = await appWithGuard().request('/x', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '2' }, body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('accepts multipart/form-data (file uploads — the 260630 documents-upload fix)', async () => {
    const res = await appWithGuard().request('/x', {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=abc', 'content-length': '20' }, body: 'x',
    });
    expect(res.status).toBe(200);
  });

  it('rejects an unexpected content-type with 415', async () => {
    const res = await appWithGuard().request('/x', {
      method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '5' }, body: 'hello',
    });
    expect(res.status).toBe(415);
  });

  it('enforces the 10MB body-size cap (413)', async () => {
    const res = await appWithGuard().request('/x', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(11 * 1024 * 1024) }, body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('SEC-4 (J-W4): a CHUNKED body (Transfer-Encoding, no Content-Length) with a bad content-type is 415', async () => {
    // Previously the content-type gate ran only when Content-Length > 0, so a chunked/streamed request
    // with no Content-Length bypassed it. Now Transfer-Encoding also counts as "has a body".
    const res = await appWithGuard().request('/x', {
      method: 'POST', headers: { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' }, body: 'hello',
    });
    expect(res.status).toBe(415);
  });

  it('SEC-4: a genuinely bodyless POST (no Content-Length, no Transfer-Encoding) still passes (admin action-in-URL)', async () => {
    const res = await appWithGuard().request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});
