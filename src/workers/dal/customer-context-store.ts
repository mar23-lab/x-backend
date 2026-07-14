// customer-context-store.ts · S1 (260628) · the ONE place the captured onboarding context is
// distilled for consumption. Closes the write-only-silo bug (Part Q): the readiness questions +
// maturity the customer enters are projected into a small, customer-safe CustomerContextProfile
// that BOTH the MCP get_effective_profile envelope AND the in-app cockpit chat + digest read — so
// the connected Claude Code and the in-app assistant actually KNOW the company, instead of three
// prompts hardcoding "regulated-SMB accounting/building inspection" for every customer.
//
// Pure projection (buildCustomerContextProfile) + a thin DAL getter + a prompt preamble renderer.
// No new table, no migration — the single source of truth stays readiness_assessments.

import { getReadinessAssessmentByWorkspaceRow } from './customer-readiness-store';
import type { Sql } from '../db/client';
import type { ReadinessAssessment } from './types';

export interface CustomerContextProfile {
  schema_id: 'xlooop.customer_context_profile.v1';
  company: { name: string | null; domain: string | null; country: string | null };
  /** q1 — the stated 90-day focus / biggest problem. */
  focus_90d: string | null;
  /** q4 — Grow | Sustain | Transition | Exit. */
  growth_posture: string | null;
  /** deep_level → "L{n}/5". */
  maturity_level: string | null;
  /** ai_tools the customer already uses. */
  ai_tools_in_use: string[];
  /** q2 — top-customer revenue concentration (free-form / "I don't know"). */
  customer_concentration: string | null;
  /** q3 (+ q3_detail) — cyber incidents/near-misses flagged. */
  cyber_flag: string | null;
  /** q5 — anything else the customer told us. */
  notes: string | null;
  /** where the customer's work lives — populated from the integrations picker (Wave C). */
  data_lives_in: string[];
  /** Wave B · REAL public-signal findings (SPF/DMARC/TLS/breach/tech) distilled from the
   *  enrichment sweep stored on the assessment. Only 'found' signals — never a fabricated claim. */
  public_signals: string[];
  /** 'stated' = the customer gave real answers; 'none' = nothing captured → consumers use the generic fallback. */
  provenance: 'stated' | 'none';
}

function emptyProfile(): CustomerContextProfile {
  return {
    schema_id: 'xlooop.customer_context_profile.v1',
    company: { name: null, domain: null, country: null },
    focus_90d: null, growth_posture: null, maturity_level: null,
    ai_tools_in_use: [], customer_concentration: null, cyber_flag: null, notes: null,
    data_lives_in: [], public_signals: [], provenance: 'none',
  };
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** PURE: distill the enrichment-sweep JSONB (Wave B) into short public-signal lines.
 *  Only 'found' signals with a detail surface as facts — 'not_configured'/'error'/'blocked'/
 *  'not_found' NEVER become a claim (the honest-data rule the S7 sweep gate enforces on the
 *  UI, applied here to the AI-facing projection so the AI never states an unverified signal). */
export function publicSignalsFromEnrichment(enrichment: Record<string, unknown> | null | undefined): string[] {
  if (!enrichment || typeof enrichment !== 'object') return [];
  const e = enrichment as Record<string, unknown>;
  const out: string[] = [];
  // Wave-B shape: the BACKEND sweep's `sources` (in-app path). Only 'found' signals become claims.
  const sources = e.sources;
  if (Array.isArray(sources)) {
    for (const r of sources) {
      if (r && typeof r === 'object' && (r as { status?: unknown }).status === 'found' && (r as { detail?: unknown }).detail) {
        out.push(`${(r as { label?: unknown }).label}: ${(r as { detail?: unknown }).detail}`);
      }
    }
  }
  // x-web shape: the WEBSITE funnel's scraped enrichment (stack / firmographics / cyber). Previously stored
  // on the assessment but NEVER read here — a write-only silo (S7). Only real values surface; never fabricated.
  const stack = e.stack;
  if (Array.isArray(stack) && stack.length) {
    const names = stack.map((t) => (t && typeof t === 'object' ? (t as { name?: unknown }).name : t)).filter(Boolean).map(String).slice(0, 8);
    if (names.length) out.push(`Technology stack: ${names.join(', ')}`);
  }
  const fg = e.firmographics as { legalName?: unknown; identifiers?: Record<string, unknown> } | undefined;
  if (fg && typeof fg === 'object') {
    const ids = (fg.identifiers || {}) as Record<string, unknown>;
    const idStr = ids.abn ? `ABN ${ids.abn}` : ids.companyNumber ? `company no. ${ids.companyNumber}` : ids.nzbn ? `NZBN ${ids.nzbn}` : null;
    const name = typeof fg.legalName === 'string' ? fg.legalName : null;
    if (name || idStr) out.push(`Registered entity: ${[name, idStr].filter(Boolean).join(' · ')}`);
  }
  const cyber = e.cyber;
  if (Array.isArray(cyber)) {
    for (const c of cyber) {
      if (c && typeof c === 'object') {
        const st = (c as { state?: unknown }).state;
        const label = (c as { label?: unknown }).label;
        if (st === 'pass') out.push(`${label}: configured`);
        else if (st === 'fail') out.push(`${label}: missing`);
      }
    }
  }
  return out;
}

/** PURE: distill a readiness assessment into the customer-safe context profile. Tolerant of partial data. */
export function buildCustomerContextProfile(a: ReadinessAssessment | null): CustomerContextProfile {
  if (!a) return emptyProfile();
  const ans = (a.readiness_answers && typeof a.readiness_answers === 'object' ? a.readiness_answers : {}) as Record<string, unknown>;
  const aiTools = Array.isArray(ans.ai_tools) ? (ans.ai_tools as unknown[]).map((t) => String(t)).filter(Boolean) : [];
  const dataLivesIn = Array.isArray(ans.integrations)
    ? (ans.integrations as Array<Record<string, unknown>>).map((i) => s(i?.id) || s(i?.label)).filter(Boolean) as string[]
    : [];
  const q3 = s(ans.q3);
  const q3detail = s(ans.q3_detail);
  const cyberFlag = q3 === 'yes'
    ? (q3detail ? `incident / near-miss flagged: ${q3detail}` : 'incident / near-miss flagged')
    : (q3 === 'no' ? 'nothing flagged' : null);
  const publicSignals = publicSignalsFromEnrichment(a.enrichment);
  const hasContent = !!(s(ans.q1) || s(ans.q4) || aiTools.length || a.deep_level != null || publicSignals.length);
  return {
    schema_id: 'xlooop.customer_context_profile.v1',
    company: { name: s(a.company_name), domain: s(a.domain), country: s(a.country) },
    focus_90d: s(ans.q1),
    growth_posture: s(ans.q4),
    maturity_level: a.deep_level != null ? `L${a.deep_level}/5` : null,
    ai_tools_in_use: aiTools,
    customer_concentration: s(ans.q2),
    cyber_flag: cyberFlag,
    notes: s(ans.q5),
    data_lives_in: dataLivesIn,
    public_signals: publicSignals,
    provenance: hasContent ? 'stated' : 'none',
  };
}

/** PURE: render the profile as a system-prompt preamble. When provenance is 'none', returns the
 *  generic line (byte-equivalent to the old hardcoded behaviour) so an empty/failed lookup never degrades. */
export function companyContextPreamble(p: CustomerContextProfile | null): string {
  if (!p || p.provenance === 'none') {
    return 'You are the operations chief-of-staff for a small-to-mid-size business operator.';
  }
  const parts: string[] = [];
  parts.push(`You are the operations chief-of-staff for ${p.company.name ? p.company.name : 'this business'}${p.company.domain ? ` (${p.company.domain})` : ''}.`);
  if (p.focus_90d) parts.push(`Their stated 90-day focus: "${p.focus_90d}".`);
  if (p.growth_posture) parts.push(`Over the next year they are trying to ${p.growth_posture.toLowerCase()} the business.`);
  if (p.maturity_level) parts.push(`AI-readiness depth: ${p.maturity_level}.`);
  if (p.ai_tools_in_use.length) parts.push(`AI tools already in use: ${p.ai_tools_in_use.join(', ')}.`);
  if (p.customer_concentration) parts.push(`Top-customer revenue concentration: ${p.customer_concentration}.`);
  if (p.cyber_flag) parts.push(`Cyber posture: ${p.cyber_flag}.`);
  if (p.data_lives_in.length) parts.push(`Their work lives in: ${p.data_lives_in.join(', ')}.`);
  if (p.public_signals.length) parts.push(`Public signals we verified: ${p.public_signals.join('; ')}.`);
  if (p.notes) parts.push(`They also told us: "${p.notes}".`);
  parts.push('Use this company context to tailor your answers, but never invent facts beyond it and the event records below.');
  return parts.join(' ');
}

/** PURE: a short company descriptor for digest/welcome prompts (not the full chief-of-staff preamble).
 *  Neutral fallback when nothing is captured — NEVER the old "accounting / building inspection" stereotype. */
export function companyDescriptor(p: CustomerContextProfile | null): string {
  if (!p || p.provenance === 'none') return 'a small-to-mid-size business operator';
  const name = p.company.name || 'a small-to-mid-size business operator';
  return p.focus_90d ? `${name} (focused on: "${p.focus_90d}")` : name;
}

/** DAL: resolve the customer's captured context by workspace id (the seam for the cockpit + MCP). */
export async function getCustomerContextProfileRow(sql: Sql, workspaceId: string): Promise<CustomerContextProfile> {
  if (!workspaceId) return emptyProfile();
  const a = await getReadinessAssessmentByWorkspaceRow(sql, workspaceId);
  return buildCustomerContextProfile(a);
}
