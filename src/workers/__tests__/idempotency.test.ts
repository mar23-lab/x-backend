// idempotency.test.ts · Wave Y (260711) — the write-path Idempotency-Key mechanism.
// DECLARED AXES: store [reserve owned/replay/in_progress · fail-open on throwing sql · complete/release
// best-effort] · wrapper via Hono [flag-off passthrough (sql never touched) · no-header passthrough ·
// owned ⇒ handler runs once + completes · replay ⇒ handler NOT called, stored body + Idempotency-Replayed ·
// in_progress ⇒ 409, handler NOT called].

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { reserveIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../dal/idempotency-store';
import { withIdempotency, idempotencyMiddleware } from '../lib/idempotency';

// A tagged-template sql mock that routes by statement text.
function makeSql(script: { insertReturns?: unknown[]; selectRow?: Record<string, unknown> | null; log?: string[] }) {
  const log = script.log ?? (script.log = []);
  return ((strings: TemplateStringsArray) => {
    const q = strings.join(' ');
    if (q.includes('INSERT INTO idempotency_keys')) { log.push('insert'); return Promise.resolve(script.insertReturns ?? []); }
    if (q.includes('SELECT response_status')) { log.push('select'); return Promise.resolve(script.selectRow ? [script.selectRow] : []); }
    if (q.includes('UPDATE idempotency_keys')) { log.push('update'); return Promise.resolve([]); }
    if (q.includes('DELETE FROM idempotency_keys')) { log.push('delete'); return Promise.resolve([]); }
    return Promise.resolve([]);
  }) as never;
}
const throwingSql = (() => Promise.reject(new Error('relation "idempotency_keys" does not exist'))) as never;

describe('idempotency-store — reserve-first semantics', () => {
  it('fresh key ⇒ owned (INSERT wins)', async () => {
    const r = await reserveIdempotencyKey(makeSql({ insertReturns: [{ id: 1 }] }), 'org_x', 'k1', 'POST /t');
    expect(r.status).toBe('owned');
  });
  it('conflict + completed row ⇒ replay with stored status+body', async () => {
    const r = await reserveIdempotencyKey(makeSql({ insertReturns: [], selectRow: { response_status: 201, response_body: { packet: { id: 'p1' } } } }), 'org_x', 'k1', 'POST /t');
    expect(r).toEqual({ status: 'replay', responseStatus: 201, body: { packet: { id: 'p1' } } });
  });
  it('conflict + un-completed reservation ⇒ in_progress', async () => {
    const r = await reserveIdempotencyKey(makeSql({ insertReturns: [], selectRow: { response_status: null, response_body: null } }), 'org_x', 'k1', 'POST /t');
    expect(r.status).toBe('in_progress');
  });
  it('missing table / throwing sql ⇒ fail-open to owned (write never 500s)', async () => {
    const r = await reserveIdempotencyKey(throwingSql, 'org_x', 'k1', 'POST /t');
    expect(r.status).toBe('owned');
  });
  it('missing workspace/key ⇒ owned (no dedupe substrate)', async () => {
    expect((await reserveIdempotencyKey(makeSql({}), '', 'k1', 'r')).status).toBe('owned');
    expect((await reserveIdempotencyKey(makeSql({}), 'org_x', '', 'r')).status).toBe('owned');
  });
  it('complete + release swallow a throwing sql', async () => {
    await expect(completeIdempotencyKey(throwingSql, 'org_x', 'k1', 201, { a: 1 })).resolves.toBeUndefined();
    await expect(releaseIdempotencyKey(throwingSql, 'org_x', 'k1')).resolves.toBeUndefined();
  });
});

// ── wrapper via a real Hono route ─────────────────────────────────────────────────────────────────
function app(script: { insertReturns?: unknown[]; selectRow?: Record<string, unknown> | null; log?: string[] }, handler: () => Promise<Response> | Response, auth: Record<string, unknown> = { workspace_id: 'org_x' }) {
  const a = new Hono();
  a.use('*', async (ctx, next) => { ctx.set('auth', auth as never); ctx.set('sql', makeSql(script) as never); await next(); });
  a.post('/t', (ctx) => withIdempotency(ctx, 'POST /t', async () => handler()));
  return a;
}
const post = (a: Hono, env: Record<string, unknown>, headers: Record<string, string> = {}) =>
  a.request('/t', { method: 'POST', headers }, env as never);

describe('withIdempotency wrapper', () => {
  it('flag OFF ⇒ handler runs, byte-identical, sql NEVER touched', async () => {
    const script = { log: [] as string[] };
    const handler = vi.fn(() => new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const res = await post(app(script, handler), {}, { 'Idempotency-Key': 'k1' });
    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(script.log).toHaveLength(0); // no reserve/select/update
  });

  it('flag ON but NO header ⇒ passthrough, sql untouched', async () => {
    const script = { log: [] as string[] };
    const handler = vi.fn(() => new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const res = await post(app(script, handler), { IDEMPOTENCY_ENABLED: 'true' }, {});
    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(script.log).toHaveLength(0);
  });

  it('owned ⇒ handler runs once, 2xx completes the row', async () => {
    const script = { insertReturns: [{ id: 1 }], log: [] as string[] };
    const handler = vi.fn(() => new Response(JSON.stringify({ packet: { id: 'p1' } }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const res = await post(app(script, handler), { IDEMPOTENCY_ENABLED: 'true' }, { 'Idempotency-Key': 'k1' });
    expect(res.status).toBe(201);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(script.log).toContain('insert');
    expect(script.log).toContain('update'); // completed
  });

  it('replay ⇒ handler NOT called, stored body + Idempotency-Replayed header', async () => {
    const script = { insertReturns: [], selectRow: { response_status: 201, response_body: { packet: { id: 'p1' } } }, log: [] as string[] };
    const handler = vi.fn(() => new Response('should-not-run', { status: 500 }));
    const res = await post(app(script, handler), { IDEMPOTENCY_ENABLED: 'true' }, { 'Idempotency-Key': 'k1' });
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await res.json()).toEqual({ packet: { id: 'p1' } });
  });

  it('in_progress ⇒ 409, handler NOT called', async () => {
    const script = { insertReturns: [], selectRow: { response_status: null, response_body: null }, log: [] as string[] };
    const handler = vi.fn(() => new Response('nope', { status: 201 }));
    const res = await post(app(script, handler), { IDEMPOTENCY_ENABLED: 'true' }, { 'Idempotency-Key': 'k1' });
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });

  it('owned + non-2xx ⇒ reservation released (retry can proceed)', async () => {
    const script = { insertReturns: [{ id: 1 }], log: [] as string[] };
    const handler = vi.fn(() => new Response(JSON.stringify({ error: 'bad' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const res = await post(app(script, handler), { IDEMPOTENCY_ENABLED: 'true' }, { 'Idempotency-Key': 'k1' });
    expect(res.status).toBe(400);
    expect(script.log).toContain('delete'); // released
  });
});

// ── group-level middleware (the rollout applicator) ────────────────────────────────────────────────
function mwApp(script: { insertReturns?: unknown[]; selectRow?: Record<string, unknown> | null; log?: string[] }) {
  const a = new Hono();
  a.use('*', async (ctx, next) => { ctx.set('auth', { workspace_id: 'org_x' } as never); ctx.set('sql', makeSql(script) as never); await next(); });
  a.use('*', idempotencyMiddleware());
  a.post('/w', (ctx) => { ctx.status(201); return ctx.json({ packet: { id: 'p1' } }); });
  a.get('/w', (ctx) => ctx.json({ read: true }));
  return a;
}
const mwReq = (a: Hono, method: string, env: Record<string, unknown>, headers: Record<string, string> = {}) =>
  a.request('/w', { method, headers }, env as never);

describe('idempotencyMiddleware — group applicator', () => {
  it('GET ⇒ passthrough (non-mutating, sql untouched)', async () => {
    const script = { log: [] as string[] };
    const res = await mwReq(mwApp(script), 'GET', { IDEMPOTENCY_ENABLED: 'true' }, { 'Idempotency-Key': 'k1' });
    expect(res.status).toBe(200);
    expect(script.log).toHaveLength(0);
  });
  it('POST flag OFF ⇒ passthrough (byte-identical, sql untouched)', async () => {
    const script = { log: [] as string[] };
    const res = await mwReq(mwApp(script), 'POST', {}, { 'Idempotency-Key': 'k1' });
    expect(res.status).toBe(201);
    expect(script.log).toHaveLength(0);
  });
  it('POST owned ⇒ handler runs, 2xx completes', async () => {
    const script = { insertReturns: [{ id: 1 }], log: [] as string[] };
    const res = await mwReq(mwApp(script), 'POST', { IDEMPOTENCY_ENABLED: 'true' }, { 'Idempotency-Key': 'k1' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ packet: { id: 'p1' } });
    expect(script.log).toContain('insert');
    expect(script.log).toContain('update');
  });
  it('POST replay ⇒ stored body (NOT the handler body) + Idempotency-Replayed', async () => {
    const script = { insertReturns: [], selectRow: { response_status: 201, response_body: { packet: { id: 'STORED' } } }, log: [] as string[] };
    const res = await mwReq(mwApp(script), 'POST', { IDEMPOTENCY_ENABLED: 'true' }, { 'Idempotency-Key': 'k1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await res.json()).toEqual({ packet: { id: 'STORED' } }); // proves the handler did NOT run
  });
  it('POST in_progress ⇒ 409', async () => {
    const script = { insertReturns: [], selectRow: { response_status: null, response_body: null }, log: [] as string[] };
    const res = await mwReq(mwApp(script), 'POST', { IDEMPOTENCY_ENABLED: 'true' }, { 'Idempotency-Key': 'k1' });
    expect(res.status).toBe(409);
  });
});
