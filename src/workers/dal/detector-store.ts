// detector-store.ts · LEM-v4 detector_config read + versioned-append group (R51-γ/δ-B2).
//
// Authority: docs/architecture/XLOOOP_SYSTEM_DESIGN_v1.md §16 · DATABASE_SCHEMA_V1.md
// (detector_config) · migration 009_lem_v4_inference_audit. Lifted verbatim out of
// WorkersDalAdapter (Stage 3.1, F10) to decompose the DAL god-object; behaviour is byte-for-byte
// identical to the prior inline methods.
//
// The DAL methods are now thin delegations (return <name>Row(this.sql, ...)). These methods are
// NOT workspace-scoped (the detector config is operator/system-scoped; the genesis seed reads the
// single active row and the inference engine writes a new version), so there is no
// assertWorkspaceScope call — identical to the inline originals. Each method keeps its own local
// `toIso` mapper (the read variant returns string|null, the insert variant returns string) — the
// inference-audit methods in ./inference-store use their own separate mappers and never reference
// these, so detector_config + its mappers move here cleanly.
//
// SMOKE NOTE (R51-δ-B): the inline detector_config SQL (INSERT INTO detector_config +
// getActiveDetectorConfig/insertDetectorConfig method bodies) MOVED here from WorkersDalAdapter.ts.
// The smoke source gate (scripts/smoke-cli.v3-source.mjs · R51-δ-B "zero remaining NOT_IMPLEMENTED
// stubs for the 10 LEM-v4 methods" ~L4015) was retargeted to read DAL + inference-store +
// detector-store as a combined source so the grep targets follow the feature.

import type { DalAdapter } from './DalAdapter';
import type { Sql } from '../db/client';

// ------------------------------------------------------------
// Public store functions (delegation targets)
// ------------------------------------------------------------

export async function getActiveDetectorConfigRow(sql: Sql) {
  const rows = (await sql/*sql*/`
    SELECT version_id, weights, thresholds, signal_names,
           activated_at, deactivated_at, notes, created_by
    FROM detector_config
    WHERE deactivated_at IS NULL
    ORDER BY activated_at DESC
    LIMIT 1
  `) as any[];
  if (!rows.length) return null;
  const r: any = rows[0];
  const toIso = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return {
    version_id: r.version_id,
    weights: r.weights ?? {},
    thresholds: r.thresholds ?? {},
    signal_names: Array.isArray(r.signal_names) ? r.signal_names : [],
    activated_at: toIso(r.activated_at) ?? '',
    deactivated_at: toIso(r.deactivated_at),
    notes: r.notes ?? null,
    created_by: r.created_by ?? 'system',
  };
}

export async function insertDetectorConfigRow(
  sql: Sql,
  input: Parameters<DalAdapter['insertDetectorConfig']>[0],
) {
  // R51-δ-B2 · append a new versioned detector_config row.
  //
  // Caller is responsible for deactivating the prior active row in the
  // same transaction (typically: UPDATE detector_config SET deactivated_at
  // = now() WHERE deactivated_at IS NULL, then this INSERT). The partial
  // unique index uq_detector_config_active (migration 009) enforces
  // single-active invariant — concurrent inserts of two active rows
  // raise unique_violation.
  const rows = (await sql/*sql*/`
    INSERT INTO detector_config (
      version_id, weights, thresholds, signal_names,
      activated_at, deactivated_at, notes, created_by
    ) VALUES (
      ${input.version_id},
      ${JSON.stringify(input.weights)}::jsonb,
      ${JSON.stringify(input.thresholds)}::jsonb,
      ${input.signal_names},
      ${input.activated_at ?? null},
      ${input.deactivated_at ?? null},
      ${input.notes ?? null},
      ${input.created_by}
    )
    RETURNING version_id, weights, thresholds, signal_names,
              activated_at, deactivated_at, notes, created_by
  `) as any[];
  if (!rows.length) throw new Error('insertDetectorConfig: no row returned');
  const r: any = rows[0];
  const toIso = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  return {
    version_id: r.version_id,
    weights: r.weights ?? {},
    thresholds: r.thresholds ?? {},
    signal_names: Array.isArray(r.signal_names) ? r.signal_names : [],
    activated_at: toIso(r.activated_at),
    deactivated_at: r.deactivated_at ? toIso(r.deactivated_at) : null,
    notes: r.notes ?? null,
    created_by: r.created_by ?? 'system',
  };
}
