// mbp-projection.ts · R43.7 (2026-05-27) · operator-only MB-P data endpoints
//
// Authority: docs/architecture/AUTH_SURFACES_AUDIT_R42.md §5.3 (data exposure
// rule: real data via authenticated API only, never static publish dir).
//
// Why these endpoints exist:
//   - Public publish dir (data/*.json) ships only sanitized stubs (items: [],
//     public_safe: true) so unauthenticated visitors + customers can't see
//     MB-P operations data
//   - This route serves the REAL MB-P operations projection + live stream,
//     but ONLY to the configured platform operator (env var MBP_OWNER_USER_ID)
//   - Any other authenticated user (Sid, Dominic, anyone in a customer org)
//     gets 403; the cockpit shell falls back to its sanitized stubs for them
//
// Routes:
//   GET /api/v1/mbp-projection   → operations projection + manifest + gateway receipts
//   GET /api/v1/mbp-live-stream  → operations live stream
//
// Both require: valid Clerk JWT + req.user_id === env.MBP_OWNER_USER_ID
// On any auth failure → 4xx with structured envelope (no fall-through).

import { Hono } from 'hono';
import { verifyToken } from '@clerk/backend';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv } from '../middleware/auth';

// Static imports — esbuild (via wrangler) inlines these JSON files into the
// worker bundle at build time. The data physically lives in the worker binary,
// NEVER in the publicly-served Cloudflare Pages dist-cloudflare/ dir.
//
// Source path note: these JSON files are produced by
// scripts/poll-mbp-operations-live-stream.mjs which polls the MB-P repo's
// _sys/xcp-system/cross_repo_drafts/Xlooop-XCP-demo/data/ exports. The
// `prepare-cloudflare-pages.mjs --env=test` mode REPLACES these with sanitized
// stubs in the Pages bundle, but the originals stay on disk + are picked up
// here at worker-build time (tsconfig.workers.json has resolveJsonModule).
import mbpOperationsProjection from '../../../data/mbp-operations-projection.json';
import mbpProjectionExportManifest from '../../../data/mbp-projection-export-manifest.json';
import mbpGatewayReceipts from '../../../data/mbp-gateway-receipts.json';
import operationsLiveStream from '../../../data/operations-live-stream.json';
// R43.20 (2026-05-27): operator-only SPACES + WS_PROJECTS overlay. The deployed
// Pages bundle ships a customer-safe sanitized spaces.json (only the redacted
// APS workspace). When the operator signs in, this hydrator pushes the full
// marat-graph workspace list so they see mbp-private, xcp-platform, xlooop,
// x-biz, x-docs, x-front in the workspace switcher.
import operatorSpaces from '../../../data/spaces.json';
import operatorWsProjects from '../../../data/ws-projects.json';
import operatorMe from '../../../data/me.json';
import operatorNavConfig from '../../../data/nav-config.json';
// 260710-F M4 (H1) · the projection live rail — pure helpers + the route-owned stream id.
import {
  PROJECTION_STREAM_ID,
  PROJECTION_RAIL_SCHEMA,
  validateProjectionRailEnvelope,
  computeProjectionFreshness,
  type ProjectionRailEnvelope,
} from '../lib/mbp-projection-live-rail';
import { envFlagTrue } from '../lib/env-flag';

export interface MbpProjectionEnv extends AuthEnv {
  MBP_OWNER_USER_ID?: string; // Clerk user_id of the operator (e.g. user_3EI...)
  // R53-W2 · shared secret the MB-P push job presents as a bearer token to
  // POST /api/v1/mbp-live-stream/ingest. Set via: wrangler secret put
  // MBP_LIVE_STREAM_INGEST_TOKEN. Absent ⇒ ingest endpoint returns 503 (closed).
  MBP_LIVE_STREAM_INGEST_TOKEN?: string;
  // 260710-F M4 (H1) · read-side flag: GET /mbp-projection serves the DB rail snapshot first when
  // 'true' (deliberately NOT bound in wrangler.toml — default off ⇒ code-path-identical inlined
  // behavior). The projection INGEST endpoint is ungated (additive, fail-closed 503 w/o the secret)
  // so MB-P can pre-populate the rail BEFORE this flag flips.
  MBP_PROJECTION_LIVE_RAIL_ENABLED?: string;
}

export const mbpProjectionRoute = new Hono<{ Bindings: MbpProjectionEnv }>();

// Helper: throw a structured error that the global errorEnvelope handler picks up.
class HttpError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Verify the JWT and assert the requester is the configured MB-P owner.
 * Returns the verified user_id, or THROWS an HttpError that the global
 * errorEnvelope wrapper will turn into a structured response.
 */
async function verifyMbpOwner(ctx: any): Promise<string> {
  const env = ctx.env as MbpProjectionEnv;

  const ownerUserId = (env.MBP_OWNER_USER_ID || '').trim();
  if (!ownerUserId) {
    throw new HttpError(
      'MBP_OWNER_USER_ID is not configured on this Worker',
      'SERVICE_UNAVAILABLE',
      503,
    );
  }

  const authHeader = ctx.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    throw new HttpError('missing bearer token', 'UNAUTHORIZED', 401);
  }

  try {
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
    });
    const requesterUserId = String(payload?.sub || '');
    if (!requesterUserId) {
      throw new HttpError('jwt missing sub claim', 'UNAUTHORIZED', 401);
    }
    if (requesterUserId !== ownerUserId) {
      throw new HttpError(
        'this endpoint is restricted to the platform operator',
        'FORBIDDEN',
        403,
      );
    }
    return requesterUserId;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      `jwt verification failed: ${String((err as Error)?.message || err)}`,
      'UNAUTHORIZED',
      401,
    );
  }
}

mbpProjectionRoute.get('/mbp-projection', async (ctx) => {
  try {
    const userId = await verifyMbpOwner(ctx);
    // 260710-F M4 (H1) · flag ON: serve the newest rail snapshot (projection + manifest as an atomic
    // pair — freshness is min() of the two) with HONEST freshness surfaced; absent/error ⇒ inlined
    // fallback WITH its honest (possibly expired) freshness — never a fake-fresh served_at masking a
    // lapsed lease. Flag OFF (default; envFlagTrue is quote-tolerant): code-path identical to before —
    // the DB is never touched. Contract schema string unchanged; new fields are additive (the hydrator
    // presence-checks, verified).
    if (envFlagTrue((ctx.env as MbpProjectionEnv).MBP_PROJECTION_LIVE_RAIL_ENABLED)) {
      let projection: Record<string, unknown> = mbpOperationsProjection as unknown as Record<string, unknown>;
      let manifest: Record<string, unknown> = mbpProjectionExportManifest as unknown as Record<string, unknown>;
      let servedFrom = 'bundle_fallback';
      try {
        const dal = (ctx as any).get('dal');
        if (dal && typeof dal.getLatestLiveStreamSnapshot === 'function') {
          const snap = await dal.getLatestLiveStreamSnapshot(PROJECTION_STREAM_ID);
          const env = snap?.envelope as ProjectionRailEnvelope | undefined;
          if (env && env.operations_projection && env.projection_export_manifest) {
            projection = env.operations_projection as Record<string, unknown>;
            manifest = env.projection_export_manifest as Record<string, unknown>;
            servedFrom = 'db_live';
          }
        }
      } catch (_) {
        // rail read is fail-safe — inlined fallback stands, never 500
      }
      return ctx.json({
        _meta: {
          schema: 'xlooop.mbp_projection_endpoint.v1',
          served_by: 'api.xlooop.com',
          served_at: new Date().toISOString(),
          authority: 'r43_7_authenticated_mbp_owner_only',
          requester: userId,
          served_from: servedFrom,
          freshness: computeProjectionFreshness(
            projection as { generated_at?: unknown; valid_until?: unknown },
            manifest as { valid_until?: unknown },
            Date.now(),
          ),
        },
        operations_projection: projection,
        projection_export_manifest: manifest,
        gateway_receipts: mbpGatewayReceipts,
      });
    }
    return ctx.json({
      _meta: {
        schema: 'xlooop.mbp_projection_endpoint.v1',
        served_by: 'api.xlooop.com',
        served_at: new Date().toISOString(),
        authority: 'r43_7_authenticated_mbp_owner_only',
        requester: userId,
      },
      operations_projection: mbpOperationsProjection,
      projection_export_manifest: mbpProjectionExportManifest,
      gateway_receipts: mbpGatewayReceipts,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

mbpProjectionRoute.get('/mbp-live-stream', async (ctx) => {
  try {
    const userId = await verifyMbpOwner(ctx);

    // R53-W2 · prefer the newest MB-P-pushed snapshot from the DB; fall back to
    // the build-time bundle import (defense in depth) when the table is empty or
    // the DB read fails. The envelope carries its OWN source_mode, so the cockpit
    // reports live (e.g. staged_snapshot) instead of degraded_fallback —
    // which was the root cause of "snapshot vs live".
    let envelope: any = operationsLiveStream;
    let servedFrom = 'bundle_fallback';
    try {
      const dal = (ctx as any).get('dal');
      if (dal && typeof dal.getLatestLiveStreamSnapshot === 'function') {
        const snap = await dal.getLatestLiveStreamSnapshot('mbp-operations-live-stream');
        if (snap && snap.envelope && Object.keys(snap.envelope).length > 0) {
          envelope = snap.envelope;
          servedFrom = 'db_live';
        }
      }
    } catch (_) {
      // keep bundle fallback — never 500 just because the snapshots table is missing
    }

    return ctx.json({
      _meta: {
        schema: 'xlooop.mbp_live_stream_endpoint.v1',
        served_by: 'api.xlooop.com',
        served_at: new Date().toISOString(),
        authority: 'r43_7_authenticated_mbp_owner_only',
        requester: userId,
        served_from: servedFrom,
      },
      operations_live_stream: envelope,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// R53-W2 · machine-to-machine auth for the MB-P push job. Compares the bearer
// token against the MBP_LIVE_STREAM_INGEST_TOKEN secret in constant time over
// the secret length. Throws HttpError on missing config (503) or mismatch (401).
function verifyIngestToken(ctx: any): void {
  const env = ctx.env as MbpProjectionEnv;
  const secret = (env.MBP_LIVE_STREAM_INGEST_TOKEN || '').trim();
  if (!secret) {
    throw new HttpError(
      'MBP_LIVE_STREAM_INGEST_TOKEN is not configured on this Worker',
      'SERVICE_UNAVAILABLE',
      503,
    );
  }
  const authHeader = ctx.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token || token.length !== secret.length) {
    throw new HttpError('invalid ingest token', 'UNAUTHORIZED', 401);
  }
  let diff = 0;
  for (let i = 0; i < secret.length; i++) {
    diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  if (diff !== 0) {
    throw new HttpError('invalid ingest token', 'UNAUTHORIZED', 401);
  }
}

// R53-W2 · POST /api/v1/mbp-live-stream/ingest
// The MB-P push job (scripts/push-operations-live-stream-to-workers.mjs in the
// Xlooop repo, run from where the operator's MB-P files live) POSTs the freshly
// generated operations-live-stream envelope here. Workers cannot read the
// operator's local MB-P files, so this push model is how live governance data
// reaches the DB → the GET route above serves it. Auth is the shared-secret
// bearer token (NOT Clerk) so the job can run headless.
mbpProjectionRoute.post('/mbp-live-stream/ingest', async (ctx) => {
  try {
    verifyIngestToken(ctx);

    const body = (await ctx.req.json().catch(() => null)) as any;
    if (!body || typeof body !== 'object') {
      throw new HttpError(
        'request body must be the operations-live-stream envelope (JSON object)',
        'VALIDATION_ERROR',
        400,
      );
    }
    // Accept either the bare envelope or { operations_live_stream: <envelope> }.
    const envelope =
      body.operations_live_stream && typeof body.operations_live_stream === 'object'
        ? body.operations_live_stream
        : body;
    if (!Array.isArray(envelope.rows)) {
      throw new HttpError('envelope.rows must be an array', 'VALIDATION_ERROR', 400);
    }
    if (!envelope.generated_at || typeof envelope.generated_at !== 'string') {
      throw new HttpError('envelope.generated_at (ISO string) is required', 'VALIDATION_ERROR', 400);
    }

    const dal = (ctx as any).get('dal');
    if (!dal || typeof dal.putLiveStreamSnapshot !== 'function') {
      throw new HttpError('DAL not available', 'SERVICE_UNAVAILABLE', 503);
    }
    const receipt = await dal.putLiveStreamSnapshot({
      // STABLE stream key for the DB column — the GET route reads the newest row
      // by this key. NOT envelope.stream_id, which is a unique per-generation
      // receipt id (e.g. operations-live-stream-20260529055040) and would never
      // match the GET filter. The envelope retains its own stream_id internally.
      stream_id: 'mbp-operations-live-stream',
      source_mode: typeof envelope.source_mode === 'string' ? envelope.source_mode : 'live_db',
      generated_at: envelope.generated_at,
      valid_until: typeof envelope.valid_until === 'string' ? envelope.valid_until : null,
      rows_count: envelope.rows.length,
      sha256: typeof body.sha256 === 'string' ? body.sha256 : null,
      envelope,
    });

    ctx.status(201);
    return ctx.json({
      _meta: {
        schema: 'xlooop.mbp_live_stream_ingest_receipt.v1',
        served_by: 'api.xlooop.com',
        served_at: new Date().toISOString(),
      },
      ok: true,
      ...receipt,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// 260710-F M4 (H1) · POST /api/v1/mbp-projection/ingest — the PROJECTION rail.
// A SEPARATE endpoint (not a body discriminator on the live-stream ingest): the source-grep gate
// (verify-live-stream-ingest.mjs) pins that handler byte-identical, and the deliberate
// ignore-client-keys stance is preserved by construction — the stream id below is this ROUTE's own
// literal, never derived from the request. Same bearer secret (same MB-P producer trust domain);
// fail-closed 503 when unset. Payload = the COMPOUND envelope (projection + manifest atomically —
// the operator-visible freshness is min() of the two valid_untils, so a split push would leave the
// cockpit reading the stale half). rows-shaped payloads are rejected both directions.
mbpProjectionRoute.post('/mbp-projection/ingest', async (ctx) => {
  try {
    verifyIngestToken(ctx);

    const body = (await ctx.req.json().catch(() => null)) as unknown;
    const invalid = validateProjectionRailEnvelope(body);
    if (invalid) {
      throw new HttpError(invalid, 'VALIDATION_ERROR', 400);
    }
    const envelope = body as ProjectionRailEnvelope;

    const dal = (ctx as any).get('dal');
    if (!dal || typeof dal.putLiveStreamSnapshot !== 'function') {
      throw new HttpError('DAL not available', 'SERVICE_UNAVAILABLE', 503);
    }
    const packets = (envelope.operations_projection as { packets?: unknown[] }).packets || [];
    const receipt = await dal.putLiveStreamSnapshot({
      stream_id: PROJECTION_STREAM_ID, // route-owned literal — never client-supplied
      source_mode: 'projection_live_rail',
      generated_at: envelope.generated_at,
      valid_until: envelope.valid_until,
      rows_count: Array.isArray(packets) ? packets.length : 0,
      sha256: typeof envelope.sha256 === 'string' ? envelope.sha256 : null,
      envelope,
    });

    ctx.status(201);
    return ctx.json({
      _meta: {
        schema: `${PROJECTION_RAIL_SCHEMA}.ingest_receipt`,
        served_by: 'api.xlooop.com',
        served_at: new Date().toISOString(),
      },
      ok: true,
      freshness: computeProjectionFreshness(
        envelope.operations_projection as { generated_at?: unknown; valid_until?: unknown },
        envelope.projection_export_manifest as { valid_until?: unknown },
        Date.now(),
      ),
      ...receipt,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

/**
 * R43.20 (2026-05-27): GET /api/v1/mbp-operator-spaces
 *
 * Returns the full operator workspace list + projects + nav config + me, so
 * the frontend hydrator can overlay the customer-safe sanitized stubs that
 * ship in the public Pages bundle.
 *
 * Why this exists:
 *   - prepare-cloudflare-pages.mjs --env=test replaces data/spaces.json with
 *     a customer-safe sanitized version (only APS, owner=redacted)
 *   - That keeps unauthenticated visitors + customers from seeing the marat
 *     workspace topology, but also blocks the operator from seeing it
 *   - This endpoint reads from the FULL data/spaces.json (compiled into the
 *     worker bundle, never on the public dist) and serves it only when the
 *     JWT user_id matches MBP_OWNER_USER_ID
 *
 * Privacy: operator-only. Returns 403 to anyone else.
 *
 * Response shape:
 *   { _meta, operator_spaces, operator_ws_projects, operator_me, operator_nav_config }
 *
 * Consumed by: src/runtime/mbp-projection-hydrator.js (R43.20 extension)
 * which overlays window.SPACES, window.WS_PROJECTS, window.ME, window.NAV_CONFIG
 * then dispatches `xcp:mbp-operator-spaces-hydrated` for App.jsx to re-render.
 */
mbpProjectionRoute.get('/mbp-operator-spaces', async (ctx) => {
  try {
    const userId = await verifyMbpOwner(ctx);
    return ctx.json({
      _meta: {
        schema: 'xlooop.mbp_operator_spaces_endpoint.v1',
        served_by: 'api.xlooop.com',
        served_at: new Date().toISOString(),
        authority: 'r43_20_authenticated_mbp_owner_only',
        requester: userId,
      },
      operator_spaces: operatorSpaces,
      operator_ws_projects: operatorWsProjects,
      operator_me: operatorMe,
      operator_nav_config: operatorNavConfig,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
