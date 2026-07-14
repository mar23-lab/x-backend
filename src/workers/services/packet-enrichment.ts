// packet-enrichment.ts · ARCH-006 W6 · the intent/packet PRE-ENRICHMENT generator.
//
// The operator's "standard enrichment practice": an intent should arrive PRE-ENRICHED with pros/cons,
// prior available resources in the ecosystem (similar resolved tasks / patternable solutions), web
// sources, and the best execution path per expert-LLM recommendation with quantifiable metrics. Today
// the evidence/enrichment slot is empty — nothing generates this. This generator fills it best-effort.
//
// LLM ladder (identical to answerCockpitChat): Claude (when ANTHROPIC_API_KEY is set) → Workers-AI Llama
// (env.AI binding) → a deterministic floor built from the prior-context counts. NEVER throws, NEVER
// blocks the intent create. HONESTY: web_sources stays [] unless a real source is supplied — the model
// is told not to fabricate URLs (the same guardrail cockpit-chat's deep-research uses).

import type { AiRunner } from './agent-digest';

export const ENRICHMENT_LLM_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const ENRICHMENT_CLAUDE_MODEL = 'claude-sonnet-4-6';

export interface EnrichmentObject {
  pros: string[];
  cons: string[];
  prior_resources: string[];
  web_sources: string[];
  recommended_path: string;
  metrics: Record<string, unknown>;
  confidence: number;
}

export interface EnrichmentDraft extends EnrichmentObject {
  generated_by: 'claude' | 'workers_ai' | 'deterministic';
  model: string | null;
}

export interface IntentForEnrichment {
  title: string;
  summary?: string | null;
  project_id?: string | null;
  domain_id?: string | null;
}

export interface EnrichmentPriorContext {
  similar_intents?: Array<{ title?: string | null; status?: string | null }>;
  recent_events?: Array<{ summary?: string | null; status?: string | null }>;
}

const clip = (s: unknown, n: number): string => String(s ?? '').slice(0, n);
const strArr = (v: unknown, cap = 6): string[] =>
  (Array.isArray(v) ? v : []).map((x) => clip(x, 240)).filter(Boolean).slice(0, cap);

const SYSTEM_PROMPT =
  'You are an expert operations analyst pre-enriching a work intent for a regulated-SMB operator. '
  + 'Produce a STRICT JSON object (no markdown, no prose, no code fences) with EXACTLY these keys: '
  + 'pros (array of short strings), cons (array of short strings), prior_resources (array of short '
  + 'strings referencing the operator\'s OWN similar prior intents/events provided below — never invent '
  + 'external facts), web_sources (array — leave EMPTY [] unless a real source is given; NEVER fabricate '
  + 'URLs), recommended_path (one short paragraph: the best execution path), metrics (object of '
  + 'quantifiable estimates, e.g. {"effort":"M","confidence":0.7,"risk":"low"}), confidence (number 0..1). '
  + 'Ground prior_resources ONLY in the supplied prior context. Be concise and specific.';

/** Tolerant JSON extraction — strip code fences, find the first {...}, parse. Returns null on any failure. */
function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  t = t.slice(start, end + 1);
  try { const o = JSON.parse(t); return o && typeof o === 'object' ? o as Record<string, unknown> : null; } catch { return null; }
}

/** Coerce a parsed object into a validated EnrichmentObject (type-safe, bounded, web_sources never fabricated). */
function coerceEnrichment(o: Record<string, unknown>, hasRealSource: boolean): EnrichmentObject {
  const conf = Number(o.confidence);
  return {
    pros: strArr(o.pros),
    cons: strArr(o.cons),
    prior_resources: strArr(o.prior_resources, 8),
    web_sources: hasRealSource ? strArr(o.web_sources, 6) : [], // honesty: no fabricated URLs
    recommended_path: clip(o.recommended_path, 1200),
    metrics: (o.metrics && typeof o.metrics === 'object' && !Array.isArray(o.metrics)) ? o.metrics as Record<string, unknown> : {},
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
  };
}

/** The deterministic floor — honest, grounded in the prior-context counts, no LLM, never empty/fabricated. */
function deterministicEnrichment(intent: IntentForEnrichment, prior: EnrichmentPriorContext): EnrichmentObject {
  const sim = Array.isArray(prior.similar_intents) ? prior.similar_intents : [];
  const ev = Array.isArray(prior.recent_events) ? prior.recent_events : [];
  return {
    pros: ['Clear, declared goal that can be tracked as a first-class intent.'],
    cons: sim.length === 0 ? ['No similar prior intent on record to pattern-match against yet.'] : [],
    prior_resources: sim.slice(0, 5).map((s) => `Similar prior intent: ${clip(s.title, 120)}${s.status ? ` (${s.status})` : ''}`),
    web_sources: [],
    recommended_path: `Proceed by scoping the work for "${clip(intent.title, 120)}", grounded in ${sim.length} similar prior intent(s) and ${ev.length} recent event(s) on record. Capture evidence as you go and request sign-off at the decision point.`,
    metrics: { similar_prior_intents: sim.length, recent_events: ev.length, source: 'deterministic' },
    confidence: 0.3,
  };
}

function buildUserPrompt(intent: IntentForEnrichment, prior: EnrichmentPriorContext): string {
  const sim = (Array.isArray(prior.similar_intents) ? prior.similar_intents : []).slice(0, 8)
    .map((s, i) => `  ${i + 1}. ${clip(s.title, 160)}${s.status ? ` [${s.status}]` : ''}`).join('\n');
  const ev = (Array.isArray(prior.recent_events) ? prior.recent_events : []).slice(0, 8)
    .map((e, i) => `  ${i + 1}. ${clip(e.summary, 160)}${e.status ? ` [${e.status}]` : ''}`).join('\n');
  return [
    `Intent to enrich: "${clip(intent.title, 200)}"`,
    intent.summary ? `Summary: ${clip(intent.summary, 600)}` : '',
    `Operator's OWN similar prior intents (ground prior_resources in these):\n${sim || '  (none on record)'}`,
    `Operator's recent events (context only):\n${ev || '  (none on record)'}`,
    'Return the strict JSON enrichment object now.',
  ].filter(Boolean).join('\n\n');
}

async function callClaude(apiKey: string, system: string, user: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ENRICHMENT_CLAUDE_MODEL, max_tokens: 900, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = Array.isArray(data?.content) ? data.content.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '')).join('').trim() : '';
    return text.length > 0 ? text : null;
  } catch { return null; }
}

/**
 * Generate the enrichment for an intent. Best-effort, never throws. Claude (if key) → Llama (if ai) →
 * deterministic floor. `useClaude` lets the caller gate the premium tier to on-demand /enrich only (so
 * create-time stays on the free Workers-AI + deterministic path).
 */
export async function generateIntentEnrichment(
  intent: IntentForEnrichment,
  prior: EnrichmentPriorContext = {},
  ai?: AiRunner,
  claudeKey?: string,
  useClaude = false,
): Promise<EnrichmentDraft> {
  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(intent, prior);
  const hasRealSource = false; // no web retrieval wired yet → web_sources stays []

  // Claude tier (on-demand only).
  if (useClaude && claudeKey) {
    const text = await callClaude(claudeKey, system, user);
    const parsed = text ? extractJson(text) : null;
    if (parsed) return { ...coerceEnrichment(parsed, hasRealSource), generated_by: 'claude', model: ENRICHMENT_CLAUDE_MODEL };
  }

  // Workers-AI Llama tier.
  if (ai) {
    try {
      const out = await ai.run(ENRICHMENT_LLM_MODEL, {
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: 700,
      });
      const text = String((out && typeof out === 'object' && 'response' in (out as Record<string, unknown>)) ? (out as { response?: unknown }).response ?? '' : '');
      const parsed = extractJson(text);
      if (parsed) return { ...coerceEnrichment(parsed, hasRealSource), generated_by: 'workers_ai', model: ENRICHMENT_LLM_MODEL };
    } catch { /* fall through to deterministic */ }
  }

  // Deterministic floor — honest, never empty, never fabricated.
  return { ...deterministicEnrichment(intent, prior), generated_by: 'deterministic', model: null };
}
