// src/workers/inference/detector-engine.ts
//
// R51-δ-B3 · Detector engine orchestrator.
//
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16.1 (CES + hard
// floors) + §16.2 (14-signal composite confidence) + §16.4 (audit substrate).
//
// What this module does
// ---------------------
// 1. Pulls the active detector_config (genesis row from migration 010 in R50,
//    self-maintained from Wave ζ onward).
// 2. Accepts a caller-built list of CandidateInputs (candidate-set generation
//    is a strategy decision deferred to the caller — operator-triggered
//    handlers, propagation cron, or future learned-candidate-mining).
// 3. For each candidate:
//    a. Aggregates CES inputs (DAD/EC/DDC/CDCC) directly from events.
//    b. Computes CES via composite-evidence-score.
//    c. Runs all 14 signals in deterministic order (SIGNAL_REGISTRY).
//    d. Computes composite confidence = σ(Σ wᵢ·sᵢ) where weights come from
//       detector_config.weights and the 14-signal evaluations.
//    e. If CES.shouldEmit AND composite_confidence ≥ threshold AND no
//       permanent_suppress_fingerprint match → emit a recommendation.
// 4. Writes audit trail: inference_runs (begin + complete) +
//    inference_signal_evals (per candidate × signal) + inference_emissions
//    (per emitted recommendation) + synthetic_domain_recommendation (the
//    advisory entity itself).
//
// What this module does NOT do
// ----------------------------
// - Candidate-set generation (operator-triggered or strategy-pluggable).
// - Cron scheduling (Wave ζ wires this into wrangler.toml + index.ts).
// - Anti-recommendation suppression check (only the count is queried here;
//   permanent_suppress_fingerprint enforcement lives in the writer path).
//
// Deterministic by contract
// -------------------------
// Same detectorConfig.version_id + same CandidateInputs → byte-identical
// inference_emissions (§16.3 "Determinism: 100%"). All randomness is
// banished. Caller is responsible for stable CandidateInput construction.

import { nanoid } from 'nanoid';
import type { DalAdapter } from '../dal/DalAdapter';
import type {
  DetectorConfig,
  InferenceRunKind,
  InferenceRunId,
  InferenceSignalEvalInput,
  ProjectId,
  RecommendationId,
} from '../dal/types';
import {
  computeCes,
  cesConfigFromDetectorConfig,
  R50_GENESIS_CES_CONFIG,
  type CesInputs,
  type CesResult,
} from './composite-evidence-score';
import {
  SIGNAL_REGISTRY,
  type CandidateInput,
  type SignalEvalOutput,
} from './signals';

/**
 * Caller-provided candidate set + metadata. The engine runs signals against
 * this input and decides whether to emit. Strategy (which candidates to
 * evaluate) is intentionally external — see notes above.
 */
export interface DetectorCandidate {
  readonly candidate_fingerprint: string;
  readonly project_ids: readonly ProjectId[];
  readonly events: CandidateInput['events'];
  readonly actors: readonly string[];
  readonly window_start: string; // ISO8601
  readonly window_end: string;   // ISO8601
  /** Optional human-readable label for the proposed domain. */
  readonly proposed_label?: string;
  /** Optional per-signal metadata (parent_map, memberships, goals_by_project, ...). */
  readonly metadata?: CandidateInput extends { metadata?: infer M } ? M : Record<string, any>;
  /** Default workspace_id for the emitted recommendation. */
  readonly workspace_id?: string | null;
  /** Domain id this candidate proposes against (recommended target). */
  readonly target_domain_id: string;
  /** Recommendation kind per migration 007 CHECK constraint. */
  readonly recommendation_kind?:
    | 'extend_timeline'
    | 'add_goal'
    | 'add_roadmap_item'
    | 'mark_goal_complete'
    | 'mark_roadmap_item_complete'
    | 'flag_blocker'
    | 'reorder_roadmap'
    | 'update_member_set'
    | 'archive_domain';
}

/**
 * Result of a single candidate's evaluation. Surfaced for tests + debugging;
 * the engine writes the audit trail as a side effect of `runDetectorTick`.
 */
export interface CandidateEvaluation {
  readonly candidate_fingerprint: string;
  readonly ces: CesResult;
  readonly signals: readonly SignalEvalOutput[];
  readonly composite_confidence: number;
  readonly emitted: boolean;
  readonly recommendation_id: RecommendationId | null;
  readonly emission_id: string | null;
  readonly rejection_reason?: 'ces_hard_floor' | 'confidence_below_min' | 'permanent_suppress';
  /** R51-ζ-2 · pattern_fingerprint computed for this candidate (even when not emitted) */
  readonly pattern_fingerprint?: string;
}

export interface DetectorTickResult {
  readonly run_id: InferenceRunId;
  readonly detector_config_version_id: string;
  readonly candidate_count: number;
  readonly emission_count: number;
  readonly cost_ms: number;
  readonly evaluations: readonly CandidateEvaluation[];
  readonly status: 'completed' | 'failed';
  readonly error?: string;
}

export interface RunDetectorTickOptions {
  readonly dal: DalAdapter;
  readonly candidates: readonly DetectorCandidate[];
  readonly window_start: string;
  readonly window_end: string;
  readonly kind?: InferenceRunKind;
  /** Override detector_config (otherwise reads active from DAL). */
  readonly detectorConfig?: DetectorConfig;
  /** Override clock for deterministic tests. */
  readonly now?: () => Date;
}

// ── CES input aggregation ─────────────────────────────────────────────

/**
 * Compute the four CES inputs (DAD, EC, DDC, CDCC) directly from the
 * candidate's events. These are NOT signals — they are the evidence-score
 * gate inputs per §16.1.
 *
 * - DAD: distinct UTC calendar days appearing in event.occurred_at
 * - EC:  total event count
 * - DDC: distinct candidate project_ids appearing in events
 * - CDCC: count of events that co-occurred with at least one other event
 *         from a DIFFERENT candidate project within the bucket B
 *         (default 24h)
 */
export function aggregateCesInputs(
  candidate: DetectorCandidate,
  bucketHours = 24,
): CesInputs {
  const days = new Set<string>();
  const projectsTouched = new Set<string>();
  let EC = 0;
  const projectSet = new Set(candidate.project_ids);
  // bucketKey = floor(ts / bucket_ms); per bucket track distinct projects.
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const projectsByBucket = new Map<number, Set<string>>();

  for (const ev of candidate.events) {
    if (!projectSet.has(ev.project_id)) continue;
    EC++;
    projectsTouched.add(ev.project_id);
    const ts = Date.parse(ev.occurred_at);
    if (!Number.isFinite(ts)) continue;
    const day = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD UTC
    days.add(day);
    const bucket = Math.floor(ts / bucketMs);
    let s = projectsByBucket.get(bucket);
    if (!s) {
      s = new Set();
      projectsByBucket.set(bucket, s);
    }
    s.add(ev.project_id);
  }

  // CDCC: count events that occurred in a bucket with ≥ 2 distinct candidate
  // projects. We re-walk events because we need per-event attribution.
  let CDCC = 0;
  for (const ev of candidate.events) {
    if (!projectSet.has(ev.project_id)) continue;
    const ts = Date.parse(ev.occurred_at);
    if (!Number.isFinite(ts)) continue;
    const bucket = Math.floor(ts / bucketMs);
    const s = projectsByBucket.get(bucket);
    if (s && s.size >= 2) CDCC++;
  }

  return {
    DAD: days.size,
    EC,
    DDC: projectsTouched.size,
    CDCC,
  };
}

// ── Composite confidence (§16.2) ──────────────────────────────────────

/**
 * Composite confidence = σ(Σ wᵢ·sᵢ) where wᵢ comes from
 * detectorConfig.weights[signal_name] and sᵢ is the signal's normalized
 * value. The σ (logistic sigmoid) bounds the result to [0,1].
 */
export function computeCompositeConfidence(
  signals: readonly SignalEvalOutput[],
  weights: Record<string, number>,
): { confidence: number; contribution: Record<string, { normalized: number; weight: number; contribution: number }> } {
  let weightedSum = 0;
  const contribution: Record<string, { normalized: number; weight: number; contribution: number }> = {};
  for (const sig of signals) {
    const w = typeof weights[sig.signal_name] === 'number' ? weights[sig.signal_name]! : 0;
    const c = w * sig.normalized_value;
    weightedSum += c;
    contribution[sig.signal_name] = {
      normalized: sig.normalized_value,
      weight: w,
      contribution: c,
    };
  }
  // Logistic sigmoid: 1 / (1 + e^-x). Bounds [0,1]. For weightedSum=0 → 0.5
  // (no signal evidence either way); for very positive sums → ~1.0.
  const confidence = 1 / (1 + Math.exp(-weightedSum));
  return { confidence, contribution };
}

// ── Pattern fingerprint ───────────────────────────────────────────────

/**
 * Stable hash of the candidate fingerprint + top-3 contributing signal names.
 * Used as `pattern_fingerprint` on emissions for anti-rec memory matching.
 * Same candidate + same top-3 signals → same fingerprint, even if weights
 * retune slightly.
 */
export function computePatternFingerprint(
  candidate_fingerprint: string,
  contribution: Record<string, { contribution: number }>,
): string {
  const top3 = Object.entries(contribution)
    .sort((a, b) => b[1].contribution - a[1].contribution)
    .slice(0, 3)
    .map(([name]) => name);
  return `pf_${candidate_fingerprint}__${top3.join('_')}`;
}

// ── Engine ────────────────────────────────────────────────────────────

/**
 * Run one detector tick over the provided candidate list. Writes the
 * audit trail and (where shouldEmit) writes synthetic_domain_recommendation
 * + inference_emission rows.
 */
export async function runDetectorTick(opts: RunDetectorTickOptions): Promise<DetectorTickResult> {
  const { dal, candidates, window_start, window_end, kind = 'manual_trigger' } = opts;
  const now = opts.now ?? (() => new Date());
  const startedAt = now();

  // 1. Resolve detector_config (caller override or active row from DAL).
  let detectorConfig: DetectorConfig | null = opts.detectorConfig ?? null;
  if (!detectorConfig) {
    detectorConfig = await dal.getActiveDetectorConfig();
  }
  if (!detectorConfig) {
    throw new Error(
      'runDetectorTick: no active detector_config — run migration 010 ' +
        '(R51-γ-2 genesis seed) to populate.',
    );
  }
  const cesConfig = cesConfigFromDetectorConfig(detectorConfig) ?? R50_GENESIS_CES_CONFIG;
  const composite_confidence_min =
    typeof detectorConfig.thresholds.composite_confidence_min === 'number'
      ? detectorConfig.thresholds.composite_confidence_min
      : 0.5;

  // 2. Begin the inference run.
  const run_id = `irn_${nanoid()}`;
  await dal.insertInferenceRun({
    run_id,
    detector_config_version_id: detectorConfig.version_id,
    input_event_window_start: window_start,
    input_event_window_end: window_end,
    kind,
  });

  // R51-ζ-2 · Load permanent_suppress_fingerprint set from anti-rec memory.
  // permanent-suppress cron (§16.5 loop 4) elevates 3× rejected fingerprints
  // to permanent_suppress_fingerprint in recommendation_rejections. Detector
  // skips candidates whose computed pattern_fingerprint matches one of these.
  //
  // We load the set ONCE per tick (not per candidate) for O(1) check during
  // the eval loop. Direct SQL because the DAL doesn't yet expose a dedicated
  // listPermanentSuppress() method (Wave θ adds it alongside other read-paths).
  const suppressedFingerprints = await loadPermanentSuppressFingerprints(dal);

  const evaluations: CandidateEvaluation[] = [];
  const signalEvalRows: InferenceSignalEvalInput[] = [];

  try {
    // 3. Evaluate each candidate.
    for (const cand of candidates) {
      const candidateInput: CandidateInput = {
        candidate_fingerprint: cand.candidate_fingerprint,
        project_ids: cand.project_ids,
        events: cand.events,
        actors: cand.actors,
        window_start: cand.window_start,
        window_end: cand.window_end,
      };
      // Attach metadata (used by parent_distance, membership_overlap, etc.).
      if (cand.metadata) (candidateInput as any).metadata = cand.metadata;

      const cesInputs = aggregateCesInputs(cand);
      const cesResult = computeCes(cesInputs, cesConfig);

      // Run ALL 14 signals in deterministic order (SIGNAL_REGISTRY order
      // matches detector_config.signal_names).
      const signals: SignalEvalOutput[] = SIGNAL_REGISTRY.map((sig) => sig.extract(candidateInput));

      // Compose confidence.
      const { confidence, contribution } = computeCompositeConfidence(signals, detectorConfig.weights);

      // Record per-signal evals (audit).
      for (const sig of signals) {
        const w = typeof detectorConfig.weights[sig.signal_name] === 'number'
          ? detectorConfig.weights[sig.signal_name]!
          : 0;
        signalEvalRows.push({
          run_id,
          candidate_fingerprint: cand.candidate_fingerprint,
          signal_name: sig.signal_name,
          raw_value: sig.raw_value,
          normalized_value: sig.normalized_value,
          weight_used: w,
          weighted_contribution: w * sig.normalized_value,
        });
      }

      // Emission decision: CES hard floors + composite confidence threshold.
      let emitted = false;
      let recommendation_id: RecommendationId | null = null;
      let emission_id: string | null = null;
      let rejection_reason: CandidateEvaluation['rejection_reason'];

      // R51-ζ-2 · Compute pattern_fingerprint eagerly so we can check
      // anti-rec memory BEFORE deciding to emit. This makes the suppress
      // check the OUTERMOST gate (cheaper than CES math + signal-eval
      // already happened, but emission write is what we want to avoid).
      const pattern_fingerprint = computePatternFingerprint(cand.candidate_fingerprint, contribution);

      if (suppressedFingerprints.has(pattern_fingerprint)) {
        // Anti-rec memory: operator rejected this exact pattern ≥ 3 times.
        // §16.5 loop 4 (permanent-suppress cron) marked it suppressed.
        rejection_reason = 'permanent_suppress';
      } else if (!cesResult.shouldEmit) {
        rejection_reason = 'ces_hard_floor';
      } else if (confidence < composite_confidence_min) {
        rejection_reason = 'confidence_below_min';
      } else {
        // Emit: insert recommendation + emission audit.
        // The synthetic_domain_recommendations row needs domain_id + kind
        // + payload. Wave δ-B3 uses 'add_goal' as a sensible default for
        // cross-cutting candidates (the next step is goal-authoring), but
        // the caller MAY override via cand.recommendation_kind.
        const rec_id = `sdrec_${nanoid()}`;
        await dalInsertLemV4Recommendation(dal, {
          id: rec_id,
          domain_id: cand.target_domain_id,
          workspace_id: cand.workspace_id ?? null,
          kind: cand.recommendation_kind ?? 'add_goal',
          source_event_ids: cand.events.map((ev) => ev.id),
          source_project_ids: [...cand.project_ids],
          payload: {
            proposed_synthetic_domain_label: cand.proposed_label ?? null,
            binding_member_set: [...cand.project_ids],
          },
          rationale:
            `Composite Evidence Score E=${cesResult.E.toFixed(3)} ` +
            `(DAD=${cesInputs.DAD}, EC=${cesInputs.EC}, DDC=${cesInputs.DDC}, CDCC=${cesInputs.CDCC}); ` +
            `composite_confidence=${confidence.toFixed(3)}`,
          confidence,
          evidence_score: cesResult.E,
          composite_confidence: confidence,
          pattern_fingerprint,
          signal_contribution_breakdown: contribution,
          detector_config_version_id: detectorConfig.version_id,
        });
        const em_id = `ie_${nanoid()}`;
        await dal.insertInferenceEmission({
          emission_id: em_id,
          run_id,
          recommendation_id: rec_id,
          composite_confidence: confidence,
          evidence_score: cesResult.E,
          evidence_score_breakdown: {
            DAD: cesInputs.DAD,
            EC: cesInputs.EC,
            DDC: cesInputs.DDC,
            CDCC: cesInputs.CDCC,
          },
          pattern_fingerprint,
          signal_contribution_breakdown: contribution,
          binding_member_set: [...cand.project_ids],
          proposed_synthetic_domain_label: cand.proposed_label ?? null,
        });
        emitted = true;
        recommendation_id = rec_id;
        emission_id = em_id;
      }

      evaluations.push({
        candidate_fingerprint: cand.candidate_fingerprint,
        ces: cesResult,
        signals,
        composite_confidence: confidence,
        emitted,
        recommendation_id,
        emission_id,
        rejection_reason,
        pattern_fingerprint,
      });
    }

    // 4. Bulk-write the signal-eval audit rows.
    if (signalEvalRows.length > 0) {
      await dal.bulkInsertInferenceSignalEvals(signalEvalRows);
    }

    // 5. Complete the inference run.
    const completedAt = now();
    const cost_ms = completedAt.getTime() - startedAt.getTime();
    const emission_count = evaluations.filter((e) => e.emitted).length;
    await dal.completeInferenceRun({
      run_id,
      candidate_count: candidates.length,
      emission_count,
      cost_ms,
      status: 'completed',
      metadata: {
        signals_evaluated: SIGNAL_REGISTRY.length,
        signal_names: SIGNAL_REGISTRY.map((s) => s.name),
      },
    });
    return {
      run_id,
      detector_config_version_id: detectorConfig.version_id,
      candidate_count: candidates.length,
      emission_count,
      cost_ms,
      evaluations,
      status: 'completed',
    };
  } catch (err) {
    const completedAt = now();
    const cost_ms = completedAt.getTime() - startedAt.getTime();
    try {
      await dal.completeInferenceRun({
        run_id,
        candidate_count: candidates.length,
        emission_count: evaluations.filter((e) => e.emitted).length,
        cost_ms,
        status: 'failed',
        error_text: err instanceof Error ? err.message : String(err),
      });
    } catch (e) {
      // Even the failure write failed — surface the original error.
      void e;
    }
    return {
      run_id,
      detector_config_version_id: detectorConfig.version_id,
      candidate_count: candidates.length,
      emission_count: evaluations.filter((e) => e.emitted).length,
      cost_ms,
      evaluations,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Internal: insert LEM-v4 recommendation row ────────────────────────
//
// Migration 007 created synthetic_domain_recommendations; migration 009
// ALTERed it to add LEM-v4 columns. The existing DAL `createRecommendation`
// method (if any) writes the LEM-v3 shape only. We need a LEM-v4-aware
// INSERT that populates the new columns. For now, we inline the SQL via
// a cast through `any` on the DAL (it has access to the same sql client
// the other methods use). When the DAL exposes a `createLemV4Recommendation`
// method this helper becomes a one-line delegation.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dalInsertLemV4Recommendation(dal: DalAdapter, row: {
  id: string;
  domain_id: string;
  workspace_id: string | null;
  kind: string;
  source_event_ids: string[];
  source_project_ids: string[];
  payload: Record<string, any>;
  rationale: string;
  confidence: number;
  evidence_score: number;
  composite_confidence: number;
  pattern_fingerprint: string;
  signal_contribution_breakdown: Record<string, any>;
  detector_config_version_id: string;
}): Promise<void> {
  // Reach the workers DAL's sql client via the bracket-typed any-cast.
  // WorkersDalAdapter exposes `this.sql` (used throughout the file).
  // Surface: a single INSERT writing both LEM-v3 + LEM-v4 columns +
  // a generous default expires_at (30 days).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql = (dal as any).sql;
  if (!sql) {
    throw new Error(
      'dalInsertLemV4Recommendation: DAL does not expose `sql` client. ' +
        'Use WorkersDalAdapter or wire up dal.createLemV4Recommendation().',
    );
  }
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const expires_at = new Date(Date.now() + thirtyDaysMs).toISOString();
  await sql/*sql*/`
    INSERT INTO synthetic_domain_recommendations (
      id, domain_id, workspace_id, source_event_ids, source_project_ids,
      kind, payload, rationale, confidence, status,
      generated_at, expires_at,
      evidence_score, composite_confidence, pattern_fingerprint,
      signal_contribution_breakdown, detector_config_version_id
    ) VALUES (
      ${row.id},
      ${row.domain_id},
      ${row.workspace_id},
      ${row.source_event_ids},
      ${row.source_project_ids},
      ${row.kind},
      ${JSON.stringify(row.payload)}::jsonb,
      ${row.rationale},
      ${row.confidence},
      'pending',
      now(),
      ${expires_at},
      ${row.evidence_score},
      ${row.composite_confidence},
      ${row.pattern_fingerprint},
      ${JSON.stringify(row.signal_contribution_breakdown)}::jsonb,
      ${row.detector_config_version_id}
    )
  `;
}

/**
 * R51-ζ-2 · Load the set of permanently-suppressed pattern_fingerprints from
 * the anti-rec memory table. `permanent-suppress` cron (§16.5 loop 4)
 * elevates fingerprints that crossed the 3× reject threshold by setting
 * `permanent_suppress_fingerprint` to the fingerprint value. We load DISTINCT
 * values from that column so the detector engine can do O(1) Set.has()
 * checks during the per-candidate emit loop.
 *
 * Returns a Set for O(1) check. Empty Set if no rows or DAL doesn't expose
 * `sql` (degrades gracefully — detector still emits, just without suppress).
 */
async function loadPermanentSuppressFingerprints(dal: DalAdapter): Promise<Set<string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql = (dal as any).sql;
  if (!sql) return new Set();
  try {
    const rows = (await sql/*sql*/`
      SELECT DISTINCT permanent_suppress_fingerprint
      FROM recommendation_rejections
      WHERE permanent_suppress_fingerprint IS NOT NULL
    `) as Array<{ permanent_suppress_fingerprint: string }>;
    return new Set(rows.map((r) => r.permanent_suppress_fingerprint));
  } catch (err) {
    // Failure-soft: log and return empty. The detector continues to emit.
    // A failing suppress-check is preferable to a stalled detector — the
    // operator can still reject any unwanted recommendation via the UI.
    if (typeof console !== 'undefined') {
      console.warn('loadPermanentSuppressFingerprints: query failed; suppress check skipped this tick', err);
    }
    return new Set();
  }
}
