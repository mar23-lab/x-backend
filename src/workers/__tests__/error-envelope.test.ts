// error-envelope.test.ts · J-W2 (260711-I) — pins the error-envelope wire contract (EE-1/2/3).
//
// EE-1: a thrown code that isn't in CODE_TO_STATUS must survive on the wire (not silently → INTERNAL_ERROR).
// EE-2/SEC-1: a >=500 must NOT ship the raw exception message (info-disclosure) — generic 'internal error'.
// EE-3: clientError early-returns must include request_id.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { errorEnvelope, clientError } from '../middleware/error';
import { makeError } from '../dal/shared-helpers';

function appWith(handler: (ctx: any) => Response | Promise<Response>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('request_id', 'req-test-1'); await next(); });
  app.get('/x', handler);
  return app;
}

async function call(app: Hono) {
  const res = await app.request('/x', { method: 'GET' }, { ENVIRONMENT: 'test' } as never);
  const body = await res.json() as { error: string; code: string; request_id: string };
  return { status: res.status, body };
}

describe('error envelope · J-W2 wire contract', () => {
  it('EE-1: an unregistered thrown code is PRESERVED on the wire (not downgraded to INTERNAL_ERROR)', async () => {
    // SOURCE_SYNC_ERROR is emitted by routes but is NOT in CODE_TO_STATUS.
    const { status, body } = await call(appWith((ctx) => errorEnvelope(ctx, makeError('SOURCE_SYNC_ERROR', 'provider sync failed', 502))));
    expect(status).toBe(502);
    expect(body.code).toBe('SOURCE_SYNC_ERROR');
  });

  it('EE-2/SEC-1: a >=500 ships a GENERIC message, never the raw exception text', async () => {
    const raw = 'ECONNREFUSED postgres://user:pw@10.0.0.1:5432 relation "customer_entitlements" does not exist';
    const { status, body } = await call(appWith((ctx) => errorEnvelope(ctx, new Error(raw))));
    expect(status).toBe(500);
    expect(body.error).toBe('internal error');
    expect(body.error).not.toContain('postgres');
    expect(body.error).not.toContain('customer_entitlements');
    expect(body.request_id).toBe('req-test-1');
  });

  it('EE-2: a <500 client error KEEPS its intentional message (validation text the caller needs)', async () => {
    const { status, body } = await call(appWith((ctx) => errorEnvelope(ctx, makeError('VALIDATION_ERROR', 'email is required', 400))));
    expect(status).toBe(400);
    expect(body.error).toBe('email is required');
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('EE-3: clientError includes the standard envelope with request_id', async () => {
    const { status, body } = await call(appWith((ctx) => clientError(ctx, 403, 'FORBIDDEN', 'no workspace binding')));
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'no workspace binding', code: 'FORBIDDEN', request_id: 'req-test-1' });
  });
});
