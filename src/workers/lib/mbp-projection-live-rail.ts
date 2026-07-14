// mbp-projection-live-rail.ts · 260710-F M4 (H1) — pure helpers for the MB-P projection live rail.
//
// WHY: the projection previously reached the operator ONLY as a build-time esbuild-inlined JSON,
// served unconditionally with a fresh served_at — so the 24h lease could expire (and did, Jul 9→10)
// with nothing surfacing it, and every refresh needed a repo commit + worker redeploy. H1 publishes
// the projection through the ALREADY-LIVE Neon rail (operations_live_stream_snapshots, migration 013 —
// stream_id-parameterized; zero DAL/migration change).
//
// DESIGN-CRITICAL (adversarially caught pre-build): the operator-visible freshness is
// min(projection.valid_until, manifest.valid_until) — mbp-operations-bridge.ts computes the EARLIEST
// of the two — so the MANIFEST must ride the rail in the SAME envelope (atomic pair) or the cockpit
// keeps showing "expired" from the stale inlined manifest. Gateway-receipts have no valid_until
// coupling and stay inlined.
//
// The stream id is a ROUTE-OWNED literal (never client-supplied) — same security stance as the
// live-stream ingest's deliberate ignore-client-keys rule.

export const PROJECTION_STREAM_ID = 'mbp-operations-projection';
export const PROJECTION_RAIL_SCHEMA = 'xlooop.mbp_projection_live_rail.v1';

export interface ProjectionRailEnvelope {
  _meta?: { schema?: string };
  generated_at: string;
  valid_until: string;
  operations_projection: Record<string, unknown> & { packets?: unknown };
  projection_export_manifest: Record<string, unknown> & { valid_until?: unknown };
  sha256?: string;
}

/** Validate the compound ingest envelope. Returns an error MESSAGE (string) or null when valid. */
export function validateProjectionRailEnvelope(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object (the compound projection envelope)';
  const b = body as Record<string, unknown>;
  if (typeof b.generated_at !== 'string' || !b.generated_at) return 'generated_at (ISO string) is required';
  if (typeof b.valid_until !== 'string' || !b.valid_until) return 'valid_until (ISO string) is required';
  // rows-shaped payloads belong to the LIVE-STREAM ingest, not this rail — fail closed both directions.
  if (Array.isArray(b.rows)) return 'rows-shaped envelope — POST it to /mbp-live-stream/ingest, not the projection rail';
  const proj = b.operations_projection;
  if (!proj || typeof proj !== 'object' || Array.isArray(proj)) return 'operations_projection (object) is required';
  if (Array.isArray((proj as Record<string, unknown>).rows)) return 'rows-shaped operations_projection — wrong stream';
  if (!Array.isArray((proj as Record<string, unknown>).packets)) return 'operations_projection.packets must be an array';
  const manifest = b.projection_export_manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return 'projection_export_manifest (object) is required — freshness is min(projection, manifest) valid_until; the pair must ride the rail atomically';
  }
  if (typeof (manifest as Record<string, unknown>).valid_until !== 'string') return 'projection_export_manifest.valid_until (ISO string) is required';
  return null;
}

/** The client's existing freshness vocabulary (mbp-operations-bridge.ts) — never invent a second one. */
export type ProjectionFreshnessStatus = 'fresh' | 'expiring' | 'expired' | 'unknown';

export interface ProjectionFreshness {
  status: ProjectionFreshnessStatus;
  valid_until_earliest: string | null;
  generated_at: string | null;
}

const EXPIRING_WINDOW_MS = 4 * 60 * 60 * 1000; // surface "expiring" inside the last 4h of the lease

/** Freshness from the EARLIEST of projection/manifest valid_until (the operator-visible truth). */
export function computeProjectionFreshness(
  projection: { generated_at?: unknown; valid_until?: unknown } | null | undefined,
  manifest: { valid_until?: unknown } | null | undefined,
  nowMs: number,
): ProjectionFreshness {
  const candidates = [projection?.valid_until, manifest?.valid_until]
    .map((v) => (typeof v === 'string' ? Date.parse(v) : NaN))
    .filter((n) => Number.isFinite(n));
  const generatedAt = typeof projection?.generated_at === 'string' ? projection.generated_at : null;
  if (candidates.length === 0) return { status: 'unknown', valid_until_earliest: null, generated_at: generatedAt };
  const earliest = Math.min(...candidates);
  const status: ProjectionFreshnessStatus =
    nowMs >= earliest ? 'expired' : nowMs >= earliest - EXPIRING_WINDOW_MS ? 'expiring' : 'fresh';
  return { status, valid_until_earliest: new Date(earliest).toISOString(), generated_at: generatedAt };
}
