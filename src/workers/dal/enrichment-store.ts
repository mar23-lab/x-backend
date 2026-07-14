// enrichment-store.ts · ARCH-006 W6 · the intent pre-enrichment read/write model.
//
// Authority: 031_intent_enrichments. A side table keyed 1:1 to intents.id holding the GENERATED
// enrichment (pros/cons/prior_resources/web_sources/recommended_path/metrics/confidence) with its own
// provenance (generated_by/model). Best-effort: upsert is idempotent (ON CONFLICT DO UPDATE), and a
// missing table (031 not applied) is a no-op at the call site (try/catch). Keeps every existing intents
// read byte-identical — enrichment is fetched separately, never inlined on the L0 intent row.

import type { Sql } from '../db/client';

export interface IntentEnrichmentRow {
  intent_id: string;
  pros: unknown;
  cons: unknown;
  prior_resources: unknown;
  web_sources: unknown;
  recommended_path: string | null;
  metrics: unknown;
  confidence: number | null;
  generated_by: string;
  model: string | null;
  status: string;
  generated_at: string;
  updated_at: string;
}

export interface IntentEnrichmentInput {
  pros?: unknown;
  cons?: unknown;
  prior_resources?: unknown;
  web_sources?: unknown;
  recommended_path?: string | null;
  metrics?: unknown;
  confidence?: number | null;
  generated_by?: string;
  model?: string | null;
}

const str = (v: unknown): string => (v == null ? '' : String(v));
const iso = (v: unknown): string => (v ? new Date(v as string).toISOString() : '');
const j = (v: unknown, fallback: string): string => { try { return JSON.stringify(v ?? JSON.parse(fallback)); } catch { return fallback; } };

function mapEnrichmentRow(r: Record<string, unknown>): IntentEnrichmentRow {
  return {
    intent_id: str(r.intent_id),
    pros: r.pros ?? [],
    cons: r.cons ?? [],
    prior_resources: r.prior_resources ?? [],
    web_sources: r.web_sources ?? [],
    recommended_path: r.recommended_path == null ? null : str(r.recommended_path),
    metrics: r.metrics ?? {},
    confidence: r.confidence == null ? null : Number(r.confidence),
    generated_by: str(r.generated_by) || 'deterministic',
    model: r.model == null ? null : str(r.model),
    status: str(r.status) || 'generated',
    generated_at: iso(r.generated_at),
    updated_at: iso(r.updated_at),
  };
}

/** Idempotent upsert of an intent's enrichment (regeneratable). Bodies live here; the caller is best-effort. */
export async function upsertIntentEnrichmentRow(sql: Sql, intentId: string, e: IntentEnrichmentInput): Promise<void> {
  const id = str(intentId).trim();
  if (!id) return;
  const generatedBy = ['claude', 'workers_ai', 'deterministic'].includes(str(e.generated_by)) ? str(e.generated_by) : 'deterministic';
  const conf = e.confidence == null ? null : Math.max(0, Math.min(1, Number(e.confidence)));
  await sql/*sql*/`
    INSERT INTO intent_enrichments
      (intent_id, pros, cons, prior_resources, web_sources, recommended_path, metrics, confidence, generated_by, model, status, updated_at)
    VALUES (
      ${id}, ${j(e.pros, '[]')}::jsonb, ${j(e.cons, '[]')}::jsonb, ${j(e.prior_resources, '[]')}::jsonb,
      ${j(e.web_sources, '[]')}::jsonb, ${e.recommended_path ?? null}, ${j(e.metrics, '{}')}::jsonb,
      ${conf}, ${generatedBy}, ${e.model ?? null}, 'generated', now()
    )
    ON CONFLICT (intent_id) DO UPDATE SET
      pros = EXCLUDED.pros, cons = EXCLUDED.cons, prior_resources = EXCLUDED.prior_resources,
      web_sources = EXCLUDED.web_sources, recommended_path = EXCLUDED.recommended_path, metrics = EXCLUDED.metrics,
      confidence = EXCLUDED.confidence, generated_by = EXCLUDED.generated_by, model = EXCLUDED.model,
      status = 'generated', updated_at = now()
  `;
}

/** Read one intent's enrichment. null when absent (the cockpit then shows no enrichment panel). */
export async function getIntentEnrichmentRow(sql: Sql, intentId: string): Promise<IntentEnrichmentRow | null> {
  const id = str(intentId).trim();
  if (!id) return null;
  const rows = (await sql/*sql*/`
    SELECT intent_id, pros, cons, prior_resources, web_sources, recommended_path, metrics,
           confidence, generated_by, model, status, generated_at, updated_at
    FROM intent_enrichments WHERE intent_id = ${id} LIMIT 1
  `) as Array<Record<string, unknown>>;
  return rows.length > 0 ? mapEnrichmentRow(rows[0]!) : null;
}
