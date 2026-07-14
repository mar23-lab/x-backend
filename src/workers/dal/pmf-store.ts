// pmf-store.ts · PMF (Sean Ellis) survey persistence + the very-disappointed % metric.
//
// Authority: 019_pmf_responses. North-star metric instrumentation. One response per user
// (latest wins, ON CONFLICT user_id). getPmfSummary computes the canonical PMF signal.

import { makeError, randomNanoid } from './shared-helpers';
import type { Sql } from '../db/client';

export type PmfSentiment = 'very_disappointed' | 'somewhat_disappointed' | 'not_disappointed';
const PMF_SENTIMENTS: ReadonlySet<string> = new Set([
  'very_disappointed', 'somewhat_disappointed', 'not_disappointed',
]);

export interface PmfResponseInput {
  user_id: string;
  workspace_id?: string | null;
  sentiment: PmfSentiment;
  benefit?: string | null;
  improvement?: string | null;
  persona?: string | null;
}

export interface PmfResponse {
  id: string;
  user_id: string;
  workspace_id: string | null;
  sentiment: PmfSentiment;
  benefit: string | null;
  improvement: string | null;
  persona: string | null;
  created_at: string;
  updated_at: string;
}

export interface PmfSummary {
  total: number;
  very_disappointed: number;
  somewhat_disappointed: number;
  not_disappointed: number;
  /** The metric: % of respondents who'd be "very disappointed" (0-100, 1 decimal). >40% = PMF. */
  very_disappointed_pct: number;
}

const clip = (s: unknown, max = 2000): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t ? t.slice(0, max) : null;
};

export async function recordPmfResponseRow(sql: Sql, input: PmfResponseInput): Promise<PmfResponse> {
  if (!input?.user_id) throw makeError('VALIDATION_ERROR', 'user_id is required', 400);
  if (!PMF_SENTIMENTS.has(input.sentiment)) {
    throw makeError('VALIDATION_ERROR', `sentiment must be one of: ${[...PMF_SENTIMENTS].join(', ')}`, 400);
  }
  const id = `pmf_${randomNanoid()}`;
  const rows = (await sql/*sql*/`
    INSERT INTO pmf_responses (id, user_id, workspace_id, sentiment, benefit, improvement, persona)
    VALUES (${id}, ${input.user_id}, ${input.workspace_id ?? null}, ${input.sentiment},
            ${clip(input.benefit)}, ${clip(input.improvement)}, ${clip(input.persona)})
    ON CONFLICT (user_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      sentiment    = EXCLUDED.sentiment,
      benefit      = COALESCE(EXCLUDED.benefit, pmf_responses.benefit),
      improvement  = COALESCE(EXCLUDED.improvement, pmf_responses.improvement),
      persona      = COALESCE(EXCLUDED.persona, pmf_responses.persona),
      updated_at   = now()
    RETURNING id, user_id, workspace_id, sentiment, benefit, improvement, persona, created_at, updated_at
  `) as PmfResponse[];
  if (!rows[0]) throw makeError('INTERNAL_ERROR', 'failed to record PMF response', 500);
  return rows[0];
}

export async function getPmfSummaryRow(sql: Sql): Promise<PmfSummary> {
  const rows = (await sql/*sql*/`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE sentiment = 'very_disappointed')::int AS very_disappointed,
      count(*) FILTER (WHERE sentiment = 'somewhat_disappointed')::int AS somewhat_disappointed,
      count(*) FILTER (WHERE sentiment = 'not_disappointed')::int AS not_disappointed
    FROM pmf_responses
  `) as Array<Record<string, unknown>>;
  const r = rows[0] || {};
  const total = Number(r.total || 0);
  const vd = Number(r.very_disappointed || 0);
  return {
    total,
    very_disappointed: vd,
    somewhat_disappointed: Number(r.somewhat_disappointed || 0),
    not_disappointed: Number(r.not_disappointed || 0),
    very_disappointed_pct: total > 0 ? Math.round((vd / total) * 1000) / 10 : 0,
  };
}
