// mbp-projection-live-rail.test.ts · 260710-F M4 (H1) — the projection live rail.
// DECLARED AXES: GET flag-off parity [exact key-set; DB NEVER read even when a snapshot exists] ·
// GET flag-on [db_live serve · bundle_fallback when absent · DAL-throw ⇒ fallback never 500 ·
// honest freshness both ways] · projection INGEST [503 secret unset · 401 bad token · 400 rows-shape ·
// 400 missing manifest · 201 with the ROUTE-owned stream id] · regression pin [the EXISTING
// live-stream ingest still stores its hardcoded id — previously untested anywhere].

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'owner-token') return { sub: 'user_OWNER' };
    throw new Error('bad token');
  }),
}));

import { mbpProjectionRoute } from '../routes/mbp-projection';
import { computeProjectionFreshness, validateProjectionRailEnvelope } from '../lib/mbp-projection-live-rail';

function appFor(dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => { ctx.set('request_id', 't'); ctx.set('dal', dal as never); await next(); });
  app.route('/api/v1', mbpProjectionRoute as never);
  return app;
}
const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });
const OWNER_ENV = { MBP_OWNER_USER_ID: 'user_OWNER', CLERK_SECRET_KEY: 'sk' };
const INGEST_ENV = { MBP_LIVE_STREAM_INGEST_TOKEN: 'secret-token-0123456789' };

const RAIL_ENVELOPE = {
  _meta: { schema: 'xlooop.mbp_projection_live_rail.v1' },
  generated_at: '2026-07-11T03:30:00+10:00',
  valid_until: '2026-07-12T03:30:00+10:00',
  operations_projection: { generated_at: '2026-07-11T03:30:00+10:00', valid_until: '2026-07-12T03:30:00+10:00', packets: [{ id: 'p1' }] },
  projection_export_manifest: { valid_until: '2026-07-12T03:30:00+10:00' },
};

describe('GET /mbp-projection · flag OFF (default) — code-path parity', () => {
  it('serves the inlined shape with NO served_from/freshness keys AND never touches the DB', async () => {
    const spy = vi.fn(async () => ({ envelope: RAIL_ENVELOPE }));
    const res = await appFor({ getLatestLiveStreamSnapshot: spy })
      .request('/api/v1/mbp-projection', bearer('owner-token'), OWNER_ENV as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { _meta: Record<string, unknown>; operations_projection: unknown };
    expect(Object.keys(body._meta).sort()).toEqual(['authority', 'requester', 'schema', 'served_at', 'served_by']);
    expect(body._meta).not.toHaveProperty('served_from');
    expect(body._meta).not.toHaveProperty('freshness');
    expect(spy).not.toHaveBeenCalled(); // flag-off = the DB read code path does not exist
  });
});

describe('GET /mbp-projection · flag ON (MBP_PROJECTION_LIVE_RAIL_ENABLED)', () => {
  const FLAG_ENV = { ...OWNER_ENV, MBP_PROJECTION_LIVE_RAIL_ENABLED: 'true' };

  it('snapshot present → db_live with the rail projection+manifest and computed freshness', async () => {
    const res = await appFor({ getLatestLiveStreamSnapshot: vi.fn(async () => ({ envelope: RAIL_ENVELOPE })) })
      .request('/api/v1/mbp-projection', bearer('owner-token'), FLAG_ENV as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { _meta: { served_from: string; freshness: { status: string } }; operations_projection: { packets: unknown[] } };
    expect(body._meta.served_from).toBe('db_live');
    expect(body.operations_projection.packets).toHaveLength(1);
    expect(['fresh', 'expiring', 'expired']).toContain(body._meta.freshness.status);
  });

  it('snapshot absent → bundle_fallback with HONEST freshness of the inlined copy (never fake-fresh)', async () => {
    const res = await appFor({ getLatestLiveStreamSnapshot: vi.fn(async () => null) })
      .request('/api/v1/mbp-projection', bearer('owner-token'), FLAG_ENV as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { _meta: { served_from: string; freshness: { status: string } } };
    expect(body._meta.served_from).toBe('bundle_fallback');
    expect(body._meta.freshness).toBeDefined(); // honest — even (especially) when expired
  });

  it('DAL throws → bundle_fallback, never a 500', async () => {
    const res = await appFor({ getLatestLiveStreamSnapshot: vi.fn(async () => { throw new Error('table missing'); }) })
      .request('/api/v1/mbp-projection', bearer('owner-token'), FLAG_ENV as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { _meta: { served_from: string } };
    expect(body._meta.served_from).toBe('bundle_fallback');
  });
});

describe('POST /mbp-projection/ingest · the projection rail', () => {
  const post = (app: Hono, body: unknown, token: string | null, env: Record<string, unknown>) =>
    app.request('/api/v1/mbp-projection/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }, env as never);

  it('503 when the ingest secret is unset (fail-closed)', async () => {
    const res = await post(appFor({}), RAIL_ENVELOPE, 'secret-token-0123456789', {});
    expect(res.status).toBe(503);
  });

  it('401 on a bad token', async () => {
    const res = await post(appFor({}), RAIL_ENVELOPE, 'wrong-token-0123456789x', INGEST_ENV);
    expect(res.status).toBe(401);
  });

  it('400 on a rows-shaped (live-stream) payload — wrong stream fails closed', async () => {
    const rowsShaped = { generated_at: '2026-07-11T00:00:00Z', valid_until: '2026-07-12T00:00:00Z', rows: [] };
    const res = await post(appFor({ putLiveStreamSnapshot: vi.fn() }), rowsShaped, 'secret-token-0123456789', INGEST_ENV);
    expect(res.status).toBe(400);
  });

  it('400 when the manifest is missing (the pair must ride atomically)', async () => {
    const { projection_export_manifest: _omit, ...noManifest } = RAIL_ENVELOPE;
    const res = await post(appFor({ putLiveStreamSnapshot: vi.fn() }), noManifest, 'secret-token-0123456789', INGEST_ENV);
    expect(res.status).toBe(400);
  });

  it('201 → stored with the ROUTE-owned stream id + packets count (never client-supplied)', async () => {
    const put = vi.fn(async (input: Record<string, unknown>) => ({ id: 'snap_1', rows_count: input.rows_count, generated_at: input.generated_at }));
    const res = await post(appFor({ putLiveStreamSnapshot: put }), { ...RAIL_ENVELOPE, stream_id: 'attacker-key' }, 'secret-token-0123456789', INGEST_ENV);
    expect(res.status).toBe(201);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][0].stream_id).toBe('mbp-operations-projection'); // literal, attacker key ignored
    expect(put.mock.calls[0][0].rows_count).toBe(1);
  });
});

describe('regression pin · the EXISTING live-stream ingest still stores its hardcoded id', () => {
  it('POST /mbp-live-stream/ingest → stream_id mbp-operations-live-stream regardless of envelope.stream_id', async () => {
    const put = vi.fn(async () => ({ id: 'snap_ls' }));
    const res = await appFor({ putLiveStreamSnapshot: put }).request('/api/v1/mbp-live-stream/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer secret-token-0123456789' },
      body: JSON.stringify({ stream_id: 'attacker-key', generated_at: '2026-07-11T00:00:00Z', rows: [] }),
    }, INGEST_ENV as never);
    expect(res.status).toBe(201);
    expect(put.mock.calls[0][0].stream_id).toBe('mbp-operations-live-stream');
  });
});

describe('pure helpers', () => {
  it('freshness = EARLIEST of projection/manifest valid_until (the manifest-coupling fix)', () => {
    const now = Date.parse('2026-07-11T12:00:00Z');
    const f = computeProjectionFreshness(
      { generated_at: '2026-07-11T00:00:00Z', valid_until: '2026-07-13T00:00:00Z' },
      { valid_until: '2026-07-11T06:00:00Z' }, // manifest expired first — it wins
      now,
    );
    expect(f.status).toBe('expired');
    expect(f.valid_until_earliest).toBe('2026-07-11T06:00:00.000Z');
  });
  it('validator rejects rows-shape and missing manifest; accepts the compound envelope', () => {
    expect(validateProjectionRailEnvelope(RAIL_ENVELOPE)).toBeNull();
    expect(validateProjectionRailEnvelope({ ...RAIL_ENVELOPE, rows: [] })).toMatch(/rows-shaped/);
    const { projection_export_manifest: _m, ...noManifest } = RAIL_ENVELOPE;
    expect(validateProjectionRailEnvelope(noManifest)).toMatch(/manifest/);
  });
});
