// inference-store.ts · LEM-v4 inference-audit write/read group (R51-δ).
//
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16 · DATABASE_SCHEMA_V1.md
// (inference_runs, inference_signal_evals, inference_emissions, recommendation_rejections,
// calibration_buckets) · migrations 009_lem_v4_inference_audit / 011. Lifted verbatim out of
// WorkersDalAdapter (Stage 3.1, F10) to decompose the DAL god-object; behaviour is byte-for-byte
// identical to the prior inline methods.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). These methods are
// NOT workspace-scoped (the inference audit trail is operator/system-scoped; the detector engine
// already resolved tenancy upstream), so there is no assertWorkspaceScope call — identical to the
// inline originals. The mapInferenceRun / mapInferenceEmission row-normalizers move here with the
// methods (no staying DAL method references them — getActiveDetectorConfig/insertDetectorConfig
// use their own detector-config mapper and STAY on the DAL).
//
// insertRecommendationRejectionRow calls the LOCAL countRecommendationRejectionsForFingerprintRow
// (the inline method called this.countRecommendationRejectionsForFingerprint — same query, same
// running-count semantics: priorCount + 1).
//
// SMOKE NOTE (R51-δ-A / R51-δ-B): the inline inference SQL (INSERT INTO recommendation_rejections,
// inference_runs, inference_signal_evals via UNNEST(, inference_emissions, calibration_buckets, and
// the `priorCount + 1` running count) MOVED here from WorkersDalAdapter.ts. The smoke source gates
// were retargeted to read DAL + inference-store as a combined source so the grep targets follow the
// feature (scripts/smoke-cli.v3-source.mjs · R51-δ-A ~L3947, R51-δ-B ~L4002).

import type { DalAdapter } from './DalAdapter';
import type { Sql } from '../db/client';

// ------------------------------------------------------------
// Internal helpers (lifted verbatim from WorkersDalAdapter)
// ------------------------------------------------------------

/**
 * R51-δ-B2 helper: normalize a Postgres `inference_runs` row to the
 * InferenceRun interface in dal/types.ts. Handles Date → ISO string,
 * null defaults, and JSONB metadata fallback.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapInferenceRun(row: any): import('./types').InferenceRun {
  const toIso = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return {
    run_id: row.run_id,
    started_at: toIso(row.started_at) ?? '',
    completed_at: toIso(row.completed_at),
    detector_config_version_id: row.detector_config_version_id,
    input_event_window_start: toIso(row.input_event_window_start) ?? '',
    input_event_window_end: toIso(row.input_event_window_end) ?? '',
    candidate_count: Number(row.candidate_count ?? 0),
    emission_count: Number(row.emission_count ?? 0),
    cost_ms: row.cost_ms !== null && row.cost_ms !== undefined ? Number(row.cost_ms) : null,
    kind: row.kind,
    status: row.status,
    error_text: row.error_text ?? null,
    metadata: row.metadata ?? {},
  };
}

/**
 * R51-δ-B2 helper: normalize an `inference_emissions` row to InferenceEmission.
 * JSONB columns (evidence_score_breakdown, signal_contribution_breakdown) are
 * returned as objects by the Neon driver — no JSON.parse needed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapInferenceEmission(row: any): import('./types').InferenceEmission {
  const toIso = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return {
    emission_id: row.emission_id,
    run_id: row.run_id,
    recommendation_id: row.recommendation_id,
    composite_confidence: Number(row.composite_confidence),
    evidence_score: Number(row.evidence_score),
    evidence_score_breakdown: row.evidence_score_breakdown ?? { DAD: 0, EC: 0, DDC: 0, CDCC: 0 },
    pattern_fingerprint: row.pattern_fingerprint,
    signal_contribution_breakdown: row.signal_contribution_breakdown ?? {},
    binding_member_set: Array.isArray(row.binding_member_set) ? row.binding_member_set : [],
    proposed_synthetic_domain_label: row.proposed_synthetic_domain_label ?? null,
    emitted_at: toIso(row.emitted_at),
  };
}

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function insertInferenceRunRow(sql: Sql, input: Parameters<DalAdapter['insertInferenceRun']>[0]) {
  // R51-δ-B2 · begin a detector run with status='running'. The detector
  // engine calls completeInferenceRun() at the end of the tick to flip
  // status=completed|failed and stamp cost_ms + counters.
  const rows = (await sql/*sql*/`
    INSERT INTO inference_runs (
      run_id, detector_config_version_id,
      input_event_window_start, input_event_window_end,
      kind, status
    ) VALUES (
      ${input.run_id},
      ${input.detector_config_version_id},
      ${input.input_event_window_start},
      ${input.input_event_window_end},
      ${input.kind},
      'running'
    )
    RETURNING run_id, started_at, completed_at, detector_config_version_id,
              input_event_window_start, input_event_window_end,
              candidate_count, emission_count, cost_ms, kind, status,
              error_text, metadata
  `) as any[];
  if (!rows.length) throw new Error('insertInferenceRun: no row returned');
  return mapInferenceRun(rows[0]);
}

export async function completeInferenceRunRow(sql: Sql, input: Parameters<DalAdapter['completeInferenceRun']>[0]) {
  // R51-δ-B2 · mark a run completed (or failed) with counts + cost_ms.
  const rows = (await sql/*sql*/`
    UPDATE inference_runs
    SET completed_at = now(),
        candidate_count = ${input.candidate_count},
        emission_count = ${input.emission_count},
        cost_ms = ${input.cost_ms},
        status = ${input.status},
        error_text = ${input.error_text ?? null},
        metadata = ${JSON.stringify(input.metadata ?? {})}::jsonb
    WHERE run_id = ${input.run_id}
    RETURNING run_id, started_at, completed_at, detector_config_version_id,
              input_event_window_start, input_event_window_end,
              candidate_count, emission_count, cost_ms, kind, status,
              error_text, metadata
  `) as any[];
  if (!rows.length) throw new Error(`completeInferenceRun: run ${input.run_id} not found`);
  return mapInferenceRun(rows[0]);
}

export async function bulkInsertInferenceSignalEvalsRow(sql: Sql, inputs: Parameters<DalAdapter['bulkInsertInferenceSignalEvals']>[0]) {
  // R51-δ-B2 · per-candidate × per-signal audit rows. Bulked into a single
  // INSERT for efficiency — Neon driver supports values lists up to ~1MB.
  // For very large runs (≥ 1000 rows), caller should batch in chunks of
  // 500. Detector engine (Wave δ-B3) typically writes 14 signals × ≤ 50
  // candidates = 700 rows per tick, which fits comfortably.
  if (!inputs || inputs.length === 0) return { inserted: 0 };
  // Defensive: validate input shape (CHECK constraints catch bad data on
  // INSERT but loud failures are cheaper than partial-write debugging).
  for (const ev of inputs) {
    if (ev.normalized_value < 0 || ev.normalized_value > 1) {
      throw new Error(
        `bulkInsertInferenceSignalEvals: normalized_value=${ev.normalized_value} out of [0,1] for ${ev.signal_name}`,
      );
    }
  }
  // Build a values-list via UNNEST for atomic insertion.
  const runIds = inputs.map((e) => e.run_id);
  const fingerprints = inputs.map((e) => e.candidate_fingerprint);
  const signalNames = inputs.map((e) => e.signal_name);
  const rawValues = inputs.map((e) => e.raw_value);
  const normalizedValues = inputs.map((e) => e.normalized_value);
  const weightsUsed = inputs.map((e) => e.weight_used);
  const contributions = inputs.map((e) => e.weighted_contribution);
  await sql/*sql*/`
    INSERT INTO inference_signal_evals (
      run_id, candidate_fingerprint, signal_name,
      raw_value, normalized_value, weight_used, weighted_contribution
    )
    SELECT * FROM UNNEST(
      ${runIds}::text[],
      ${fingerprints}::text[],
      ${signalNames}::text[],
      ${rawValues}::numeric[],
      ${normalizedValues}::numeric[],
      ${weightsUsed}::numeric[],
      ${contributions}::numeric[]
    )
  `;
  return { inserted: inputs.length };
}

export async function insertInferenceEmissionRow(sql: Sql, input: Parameters<DalAdapter['insertInferenceEmission']>[0]) {
  // R51-δ-B2 · audit row for each emission. FK to existing
  // synthetic_domain_recommendations (created in 007) — caller MUST have
  // already inserted that row in the same transaction.
  const rows = (await sql/*sql*/`
    INSERT INTO inference_emissions (
      emission_id, run_id, recommendation_id,
      composite_confidence, evidence_score, evidence_score_breakdown,
      pattern_fingerprint, signal_contribution_breakdown,
      binding_member_set, proposed_synthetic_domain_label
    ) VALUES (
      ${input.emission_id},
      ${input.run_id},
      ${input.recommendation_id},
      ${input.composite_confidence},
      ${input.evidence_score},
      ${JSON.stringify(input.evidence_score_breakdown)}::jsonb,
      ${input.pattern_fingerprint},
      ${JSON.stringify(input.signal_contribution_breakdown)}::jsonb,
      ${input.binding_member_set},
      ${input.proposed_synthetic_domain_label ?? null}
    )
    RETURNING emission_id, run_id, recommendation_id, composite_confidence,
              evidence_score, evidence_score_breakdown, pattern_fingerprint,
              signal_contribution_breakdown, binding_member_set,
              proposed_synthetic_domain_label, emitted_at
  `) as any[];
  if (!rows.length) throw new Error('insertInferenceEmission: no row returned');
  return mapInferenceEmission(rows[0]);
}

export async function listInferenceEmissionsForRunRow(sql: Sql, runId: Parameters<DalAdapter['listInferenceEmissionsForRun']>[0]) {
  // R51-δ-B2 · read path for the Wave ε inbox UI. Returns emissions in
  // emitted_at descending order (newest first) so the operator sees the
  // most recent candidates first.
  const rows = (await sql/*sql*/`
    SELECT emission_id, run_id, recommendation_id, composite_confidence,
           evidence_score, evidence_score_breakdown, pattern_fingerprint,
           signal_contribution_breakdown, binding_member_set,
           proposed_synthetic_domain_label, emitted_at
    FROM inference_emissions
    WHERE run_id = ${runId}
    ORDER BY emitted_at DESC
  `) as any[];
  return rows.map(mapInferenceEmission);
}

export async function insertRecommendationRejectionRow(sql: Sql, input: Parameters<DalAdapter['insertRecommendationRejection']>[0]) {
  // R51-δ-A3 · anti-recommendation memory write per §16.6.
  //
  // Compute reject_count_for_fingerprint FIRST so the new row carries the
  // running count after-this-write (1 for first reject, 2 for second, etc).
  // Self-maintenance loop 4 (Wave ζ) consults this count to elevate to
  // permanent_suppress_fingerprint after 3× rejects of same fingerprint.
  const priorCount = await countRecommendationRejectionsForFingerprintRow(
    sql,
    input.pattern_fingerprint_at_reject,
  );
  const nextCount = priorCount + 1;

  const rows = (await sql/*sql*/`
    INSERT INTO recommendation_rejections (
      recommendation_id, rejected_by, reason_text, reason_taxonomy,
      permanent_suppress_fingerprint, pattern_fingerprint_at_reject,
      reject_count_for_fingerprint
    ) VALUES (
      ${input.recommendation_id},
      ${input.rejected_by},
      ${input.reason_text ?? null},
      ${input.reason_taxonomy ?? null},
      ${input.permanent_suppress_fingerprint ?? null},
      ${input.pattern_fingerprint_at_reject},
      ${nextCount}
    )
    RETURNING id, recommendation_id, rejected_at, rejected_by,
              reason_text, reason_taxonomy, permanent_suppress_fingerprint,
              pattern_fingerprint_at_reject, reject_count_for_fingerprint
  `) as any[];
  if (!rows.length) {
    throw new Error('insertRecommendationRejection: insert returned no row');
  }
  const r: any = rows[0];
  const toIso = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return {
    id: Number(r.id),
    recommendation_id: r.recommendation_id,
    rejected_at: toIso(r.rejected_at),
    rejected_by: r.rejected_by,
    reason_text: r.reason_text ?? null,
    reason_taxonomy: r.reason_taxonomy ?? null,
    permanent_suppress_fingerprint: r.permanent_suppress_fingerprint ?? null,
    pattern_fingerprint_at_reject: r.pattern_fingerprint_at_reject,
    reject_count_for_fingerprint: Number(r.reject_count_for_fingerprint),
  };
}

export async function countRecommendationRejectionsForFingerprintRow(sql: Sql, fingerprint: string) {
  // R51-δ-A3 · counts prior rejects keyed by pattern_fingerprint_at_reject.
  // Used by insertRecommendationRejection to compute the running count.
  // Index idx_rr_fingerprint (migration 009) makes this O(log N).
  const rows = (await sql/*sql*/`
    SELECT COUNT(*)::int AS n
    FROM recommendation_rejections
    WHERE pattern_fingerprint_at_reject = ${fingerprint}
  `) as any[];
  if (!rows.length) return 0;
  const n = Number((rows[0] as any).n);
  return Number.isFinite(n) ? n : 0;
}

export async function upsertCalibrationBucketRow(sql: Sql, input: Parameters<DalAdapter['upsertCalibrationBucket']>[0]) {
  // R51-δ-B2 · upsert calibration row keyed by (pattern_kind,
  // bucket_lower, window_started_at) per uq_calibration_buckets_key in
  // migration 009. Wave ζ calibration-retrain cron (§16.5 loop 5)
  // recomputes these nightly; this DAL just persists.
  const rows = (await sql/*sql*/`
    INSERT INTO calibration_buckets (
      pattern_kind, bucket_lower, bucket_upper,
      predicted_acceptance_rate, actual_acceptance_rate,
      predicted_count, accepted_count, rejected_count, deferred_count,
      calibration_error, window_started_at, window_size_emissions
    ) VALUES (
      ${input.pattern_kind},
      ${input.bucket_lower},
      ${input.bucket_upper},
      ${input.predicted_acceptance_rate},
      ${input.actual_acceptance_rate},
      ${input.predicted_count},
      ${input.accepted_count},
      ${input.rejected_count},
      ${input.deferred_count},
      ${input.calibration_error},
      ${input.window_started_at},
      ${input.window_size_emissions}
    )
    ON CONFLICT (pattern_kind, bucket_lower, window_started_at) DO UPDATE
    SET bucket_upper = EXCLUDED.bucket_upper,
        predicted_acceptance_rate = EXCLUDED.predicted_acceptance_rate,
        actual_acceptance_rate = EXCLUDED.actual_acceptance_rate,
        predicted_count = EXCLUDED.predicted_count,
        accepted_count = EXCLUDED.accepted_count,
        rejected_count = EXCLUDED.rejected_count,
        deferred_count = EXCLUDED.deferred_count,
        calibration_error = EXCLUDED.calibration_error,
        window_size_emissions = EXCLUDED.window_size_emissions,
        computed_at = now()
    RETURNING id, pattern_kind, bucket_lower, bucket_upper,
              predicted_acceptance_rate, actual_acceptance_rate,
              predicted_count, accepted_count, rejected_count, deferred_count,
              calibration_error, window_started_at, window_size_emissions, computed_at
  `) as any[];
  if (!rows.length) throw new Error('upsertCalibrationBucket: no row returned');
  const r: any = rows[0];
  const toIso = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return {
    id: Number(r.id),
    pattern_kind: r.pattern_kind,
    bucket_lower: Number(r.bucket_lower),
    bucket_upper: Number(r.bucket_upper),
    predicted_acceptance_rate: Number(r.predicted_acceptance_rate),
    actual_acceptance_rate: Number(r.actual_acceptance_rate),
    predicted_count: Number(r.predicted_count),
    accepted_count: Number(r.accepted_count),
    rejected_count: Number(r.rejected_count),
    deferred_count: Number(r.deferred_count),
    calibration_error: Number(r.calibration_error),
    window_started_at: toIso(r.window_started_at),
    window_size_emissions: Number(r.window_size_emissions),
    computed_at: toIso(r.computed_at),
  };
}
