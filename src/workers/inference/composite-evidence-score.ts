// src/workers/inference/composite-evidence-score.ts
//
// R51-δ-A1 · Composite Evidence Score (CES) — pure deterministic function.
//
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16.1
//
// Contract:
//   E = w_d · DAD                — Distinct Active Days
//     + w_e · log(1 + EC)        — Event Count (log-damped to prevent volume dominance)
//     + w_x · DDC                — Distinct Domain Count (must be ≥ 2)
//     + w_c · CDCC               — Cross-Domain Co-occurrence (events in ≥ 2 domains within bucket B)
//
// Initial priors (R50 genesis from detector_config.thresholds in migration 010):
//   w_d = 0.25 · w_e = 0.15 · w_x = 0.30 · w_c = 0.30
//   E_min = 2.5 · DAD_min = 3 · DDC_min = 2
//
// Emission rule (HARD floors are non-negotiable):
//   shouldEmit ⇔ (E >= E_min) AND (DAD >= DAD_min) AND (DDC >= DDC_min)
//
// Reference operating points from §16.1 (these are TEST FIXTURES — see
// scripts/verify-ces-math.mjs):
//
//   Heavy user (DAD=5, EC=80, DDC=4, CDCC=5):
//     E = 0.25·5 + 0.15·log(81) + 0.30·4 + 0.30·5
//       = 1.25  + 0.15·4.394   + 1.20    + 1.50
//       = 1.25  + 0.659        + 1.20    + 1.50
//       ≈ 4.61
//
//   Light user (DAD=12, EC=15, DDC=4, CDCC=4):
//     E = 0.25·12 + 0.15·log(16) + 0.30·4 + 0.30·4
//       = 3.00   + 0.15·2.773    + 1.20    + 1.20
//       = 3.00   + 0.416         + 1.20    + 1.20
//       ≈ 5.82
//
// Both clear E_min=2.5 (and both clear DAD≥3, DDC≥2) so both emit. Same
// threshold, two honest usage profiles. The framework explicitly rejects
// "more events = more confident" — a single-day burst of 100 events (DAD=1)
// would NOT emit no matter how high EC is.
//
// log() is the natural logarithm (Math.log in JS). All inputs are integers
// in production but the math works for any non-negative reals.

/**
 * Inputs to the Composite Evidence Score function.
 */
export interface CesInputs {
  /** Distinct Active Days — count of distinct calendar days with events. */
  readonly DAD: number;
  /** Event Count — total events across the candidate domain set. */
  readonly EC: number;
  /** Distinct Domain Count — count of distinct candidate domains contributing events. */
  readonly DDC: number;
  /** Cross-Domain Co-occurrence — events in ≥ 2 candidate domains within bucket B. */
  readonly CDCC: number;
}

/**
 * Detector weights + thresholds. Sourced from the active
 * detector_config row (see WorkersDalAdapter.getActiveDetectorConfig).
 */
export interface CesConfig {
  readonly w_d: number;
  readonly w_e: number;
  readonly w_x: number;
  readonly w_c: number;
  readonly E_min: number;
  readonly DAD_min: number;
  readonly DDC_min: number;
}

/**
 * Result of CES evaluation. Captures both the score itself and the
 * emission decision (so the caller can audit-log "computed but did not
 * emit because hard floor X failed").
 */
export interface CesResult {
  readonly E: number;
  readonly shouldEmit: boolean;
  readonly hardFloorPasses: {
    readonly E_min: boolean;
    readonly DAD_min: boolean;
    readonly DDC_min: boolean;
  };
  /** Per-term contributions for audit + UI bars. */
  readonly contribution: {
    readonly DAD_term: number;
    readonly EC_term: number;
    readonly DDC_term: number;
    readonly CDCC_term: number;
  };
  /** Snapshot of inputs + config (round-trippable for reproducibility). */
  readonly inputs: CesInputs;
  readonly config: CesConfig;
}

/**
 * R50 genesis weights/thresholds — mirror the genesis detector_config row
 * inserted by migration 010_lem_v4_detector_config_seed.sql. Use this for
 * pre-DB-load tests; production should always read CesConfig from
 * `getActiveDetectorConfig()`.
 */
export const R50_GENESIS_CES_CONFIG: CesConfig = Object.freeze({
  w_d: 0.25,
  w_e: 0.15,
  w_x: 0.30,
  w_c: 0.30,
  E_min: 2.5,
  DAD_min: 3,
  DDC_min: 2,
});

/**
 * Pure function — same inputs always yield the same output. No side
 * effects. No clock reads. No DB calls.
 *
 * @param inputs the four observation counts (DAD/EC/DDC/CDCC)
 * @param config detector weights + thresholds
 */
export function computeCes(inputs: CesInputs, config: CesConfig): CesResult {
  validateInputs(inputs);
  validateConfig(config);

  const DAD_term = config.w_d * inputs.DAD;
  // log(1 + EC) — log-damped so volume doesn't dominate. EC=0 → log(1)=0
  // (the term contributes nothing if there are zero events).
  const EC_term = config.w_e * Math.log(1 + inputs.EC);
  const DDC_term = config.w_x * inputs.DDC;
  const CDCC_term = config.w_c * inputs.CDCC;

  const E = DAD_term + EC_term + DDC_term + CDCC_term;

  const hardFloorPasses = {
    E_min: E >= config.E_min,
    DAD_min: inputs.DAD >= config.DAD_min,
    DDC_min: inputs.DDC >= config.DDC_min,
  };
  const shouldEmit =
    hardFloorPasses.E_min && hardFloorPasses.DAD_min && hardFloorPasses.DDC_min;

  return {
    E,
    shouldEmit,
    hardFloorPasses,
    contribution: { DAD_term, EC_term, DDC_term, CDCC_term },
    inputs,
    config,
  };
}

/**
 * Convenience: pull CES config from an active detector_config row
 * (DAL shape from src/workers/dal/types.ts DetectorConfig).
 * Returns null if the active config does not carry all required
 * threshold/weight fields — caller should fall back to R50_GENESIS_CES_CONFIG.
 */
export function cesConfigFromDetectorConfig(
  detectorConfig: { weights: Record<string, number>; thresholds: Record<string, number> },
): CesConfig | null {
  const w = detectorConfig.weights;
  const t = detectorConfig.thresholds;

  // CES uses the FOUR family-level weights, not the 14 individual signal
  // weights. We derive them by *summing* signal weights in each family,
  // OR by treating w_d/w_e/w_x/w_c as standalone keys if present.
  //
  // Migration 010 seeds the 14 signal weights + thresholds. The family-
  // level CES weights live in thresholds.{w_d, w_e, w_x, w_c}? NO — they
  // are §16.1 priors. We embed them as constants here in R50 and lift to
  // detector_config in a later wave when self-maintenance loop 1 retunes
  // family-level weights too.
  //
  // For R50, we read thresholds for E_min/DAD_min/DDC_min and use
  // the genesis priors for w_d/w_e/w_x/w_c. This is the audited path.

  const E_min = typeof t.E_min === 'number' ? t.E_min : R50_GENESIS_CES_CONFIG.E_min;
  const DAD_min = typeof t.DAD_min === 'number' ? t.DAD_min : R50_GENESIS_CES_CONFIG.DAD_min;
  const DDC_min = typeof t.DDC_min === 'number' ? t.DDC_min : R50_GENESIS_CES_CONFIG.DDC_min;

  // Family weights: prefer explicit thresholds.w_* if present (R51-δ-B+
  // self-maintenance retunes), else fall back to R50 genesis priors.
  const w_d = typeof t.w_d === 'number' ? t.w_d : R50_GENESIS_CES_CONFIG.w_d;
  const w_e = typeof t.w_e === 'number' ? t.w_e : R50_GENESIS_CES_CONFIG.w_e;
  const w_x = typeof t.w_x === 'number' ? t.w_x : R50_GENESIS_CES_CONFIG.w_x;
  const w_c = typeof t.w_c === 'number' ? t.w_c : R50_GENESIS_CES_CONFIG.w_c;

  // Sanity check: at least one of the 14 signal weights should be present
  // (we don't use them here but their absence signals a malformed config).
  if (!w || typeof w !== 'object' || Object.keys(w).length === 0) {
    return null;
  }

  return Object.freeze({ w_d, w_e, w_x, w_c, E_min, DAD_min, DDC_min });
}

// ── input validation ─────────────────────────────────────────────────

function validateInputs(inputs: CesInputs): void {
  for (const k of ['DAD', 'EC', 'DDC', 'CDCC'] as const) {
    const v = inputs[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new CesInputError(
        `CES input ${k} must be a finite non-negative number; got ${v}`,
        k,
      );
    }
  }
}

function validateConfig(config: CesConfig): void {
  for (const k of ['w_d', 'w_e', 'w_x', 'w_c', 'E_min', 'DAD_min', 'DDC_min'] as const) {
    const v = config[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new CesInputError(
        `CES config ${k} must be a finite non-negative number; got ${v}`,
        k,
      );
    }
  }
  // Hard floor sanity: DAD_min and DDC_min are integer counts (informal
  // — JS doesn't enforce). DDC_min < 2 would defeat the cross-cutting
  // requirement; refuse such configs.
  if (config.DDC_min < 2) {
    throw new CesInputError(
      `CES config DDC_min must be ≥ 2 (§16.1 cross-cutting requirement); got ${config.DDC_min}`,
      'DDC_min',
    );
  }
}

/**
 * Error class for CES input validation failures. Carries the offending
 * field name so callers can map to UI / audit-log surfaces.
 */
export class CesInputError extends Error {
  public readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = 'CesInputError';
    this.field = field;
  }
}
