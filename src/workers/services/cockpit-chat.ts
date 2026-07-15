// cockpit-chat.ts · "Chat-that-acts v1" — the AI chief-of-staff over the scoped operations record.
//
// The cockpit chat used to be broadcast-only (capture a message → an event). This service turns it
// into an ACTOR: it reads the operator's REAL scoped events (a project, domain, or whole workspace)
// and answers a question GROUNDED in them — counts, recent items, what's blocked / needs sign-off,
// top sources. Richer via the Cloudflare Workers-AI binding when present (same binding + no-invention
// guardrails + never-throws contract as services/agent-digest.ts buildWorkspaceDigestLLM); a
// deterministic, genuinely-useful grounded digest is the fallback so a missing/failing binding can
// NEVER 5xx or fabricate. The model is fed ONLY the supplied event facts (no invention).
//
// READ-ONLY by construction: this answers ABOUT the record; it never writes events, never approves,
// never mutates. (Contrast agent-digest, which DRAFTS a pending proposal the operator approves.)
// Customer-safe vocab only.

import type { HarnessFlowEvent, EventStatus } from '../dal/types/event';
import type { AiRunner } from './agent-digest';
import { companyContextPreamble } from '../dal/customer-context-store';
import type { ModelExecutionObserver } from '../lib/model-execution-lineage';

/** The Workers-AI text model — same small instruct model the digest agent uses (free-tier friendly). */
export const COCKPIT_CHAT_LLM_MODEL = '@cf/meta/llama-3.1-8b-instruct';

/**
 * P6 · the premium tier. When `ANTHROPIC_API_KEY` is configured as a worker secret, the `deep-research`
 * mode (the one that most benefits from a stronger model) routes to Claude via the Anthropic API; every
 * other mode keeps the free Workers-AI Llama. The ladder is deterministic floor → Llama (default) →
 * Claude (premium, opt-in by mode). Claude failures fall back to Llama, which falls back to deterministic,
 * so the never-throws / never-fabricate contract is preserved. Local LLMs are intentionally NOT here —
 * they serve local MB-P work (LocalBrain), not the cloud cockpit (a Worker has no path to localhost).
 */
export const COCKPIT_CHAT_CLAUDE_MODEL = 'claude-sonnet-4-6';

/** How many recent events we ground each answer in (bounded for cost/latency). */
export const COCKPIT_CHAT_MAX_EVENTS = 60;
/** How many recent items we name explicitly in the prompt / deterministic body. */
const NAMED_RECENT = 8;

export interface CockpitChatScope {
  workspace_id: string;
  project_id?: string | null;
  domain_id?: string | null;
}

/**
 * The READ-side modes of the unified Send dropdown. All four are grounded ONLY in the scoped record
 * (never invent): `ask` answers a question; `plan` drafts a short plan; `recommend` proposes next
 * actions; `deep-research` produces a thorough internal briefing (external web research is NOT yet
 * wired, and the answer says so rather than faking sources). The WRITE modes (chat/command/intent)
 * never reach this service — they go through the operator-capture path.
 */
export type CockpitChatMode = 'ask' | 'plan' | 'recommend' | 'deep-research';

/** Per-mode system-prompt directive (appended to the base no-invention instruction). */
function modeDirective(mode: CockpitChatMode): string {
  switch (mode) {
    case 'plan':
      return ' The operator asked you to DRAFT A PLAN. Using ONLY the facts, lay out a short, concrete '
        + 'sequence of next steps to move this scope forward — ordered, each one sentence, each tied to a '
        + 'real item on the record. Do not invent work that is not implied by the facts.';
    case 'recommend':
      return ' The operator asked for RECOMMENDATIONS. Using ONLY the facts, give the top 2-3 next actions, '
        + 'each with a one-line reason grounded in a real item (what is blocked, waiting on sign-off, or stale).';
    case 'deep-research':
      return ' The operator asked for a DEEP-RESEARCH briefing. Synthesize a thorough picture from the '
        + 'record: themes, what is progressing, what is stuck, and the open questions. Ground every claim in '
        + 'the facts. If answering well would need external/web sources, say so plainly — do NOT invent them.';
    case 'ask':
    default:
      return '';
  }
}

/** Per-mode lead line for the deterministic (no-LLM) grounded answer. */
function modeLead(mode: CockpitChatMode, where: string): string | null {
  switch (mode) {
    case 'plan': return `A grounded plan for ${where}, drawn from what is on record:`;
    case 'recommend': return `My recommendations for ${where}, grounded in the record:`;
    case 'deep-research': return `A briefing on ${where} from your internal record (external web research is not yet wired):`;
    default: return null;
  }
}

/** Plane C (P1 · 260629) · a bounded view of an uploaded document the chief-of-staff can ground on. */
export interface DocumentFact {
  filename: string;
  /** A bounded slice of the document's extracted_text — the caller truncates it for prompt cost. */
  excerpt: string;
}

export interface SourceGroundingFact {
  provider: string;
  status: string;
  provider_username?: string | null;
  workspace_id?: string | null;
  workspace_binding: 'workspace_bound' | 'legacy_user_account_unbound';
  connected_at?: string | null;
  last_sync_at?: string | null;
  last_sync_error?: string | null;
  event_count: number;
  latest_event_at?: string | null;
  /** T1/P3 (260710) · OAuth scopes granted on the connection — lets the answer say "connected but missing
   *  gmail.readonly" instead of guessing. Optional; absent ⇒ prompt byte-identical to before. */
  scopes?: string[];
  /** D-16 (260710) · per-project trust tier folded to the source's effective workspace tier
   *  (index/rely/operate from project_source_bindings.read_policy). Absent ⇒ no tier weighting (flag off,
   *  byte-identical). 'rely' = leaned on MORE for grounding; NO content read (reflection_only preserved). */
  access_tier?: 'index' | 'rely' | 'operate';
}

export interface CockpitChatFacts {
  /** S1 (260628) · the captured company context (focus/maturity/AI tools/where-work-lives) when the chat
   *  is scoped to a customer workspace — makes the chief-of-staff company-aware instead of a hardcoded
   *  stereotype. Optional; null/absent → the generic fallback preamble (unchanged behaviour). */
  companyContext?: import('../dal/customer-context-store').CustomerContextProfile | null;
  /** Plane A — operation_events the answer is grounded in (scope-filtered + recency-capped by the caller). */
  events: HarnessFlowEvent[];
  /**
   * Plane B — governance packets/decisions from the MB-P operations-live-stream, already SCOPE-MAPPED
   * into the same event shape (mapGovernanceRowsToEvents). Optional + defaults to none, so existing
   * callers/tests are unchanged. This is the half the chat used to be blind to (the project board
   * reads it): merging it here is what stops the chief-of-staff under-reporting blockers/sign-offs.
   */
  governance?: GovernanceMappedEvent[];
  /**
   * Wave 3b · PINNED context cards — events/packets the operator explicitly attached to THIS question
   * (clicked into the chat, possibly from other workspaces/scopes). Already mapped to the event shape.
   * The answer leads with these and grounds on them FIRST, then the scoped record. This is what makes
   * the chat cross-context: a card carries its own scope, so the operator can ask across the cards they
   * pinned regardless of the panel's current workspace/project.
   */
  pinned?: HarnessFlowEvent[];
  /**
   * OS-4 P4 · GRAPH lineage edges for the PINNED cards (the model finally sees the graph, bounded to
   * what the operator pinned). From v_artefact_lineage via the route; absent/[] => prompt unchanged.
   */
  lineage?: import('../dal/graph-store').LineageEdgeRow[];
  /** Plane C (P1) · uploaded documents (filename + bounded excerpt of extracted_text) so the answer can
   *  ground on the customer's own docs. Absent/[] => prompt + answer byte-identical to before. */
  documents?: DocumentFact[];
  /** Source connection/sync truth for this customer workspace. Keeps chat from trusting stale setup rows. */
  sources?: SourceGroundingFact[];
  /** Total Plane-A count for the scope (may exceed events.length when capped). */
  total: number;
  scope: CockpitChatScope;
}

export interface CockpitChatResult {
  answer: string;
  generated_by: 'llm' | 'deterministic';
  /** P4 · the model that produced the answer (transparency): the Workers-AI model id, or null when the
   *  deterministic grounded floor answered (no model). The UI surfaces this so the operator always knows
   *  which model — or that it was the deterministic fallback — answered. */
  model?: string | null;
  /** G2 (260711) · per-answer LLM token usage for per-tenant metering. CAPTURE only — recording lives in
   *  dal/llm-usage-store.ts behind LLM_USAGE_METERING_ENABLED. undefined on deterministic answers; token
   *  fields null when the provider didn't report usage (Workers-AI usage is optional). */
  usage?: { tokens_in: number | null; tokens_out: number | null } | null;
  /** Provenance the UI shows so the answer visibly references the real record. */
  grounded_on: {
    /** W1 (260708) · the operation_events/governance ids the answer grounded on — the LIVE-link source the
     *  receipt substrate (migration 058) persists. Bounded by the same caps as the grounding itself. */
    event_ids?: string[];
    events_considered: number;
    events_total: number;
    completed: number;
    in_progress: number;
    blocked: number;
    needs_review: number;
    top_sources: Array<{ source: string; count: number }>;
    recent: Array<{ summary: string; status: string; when: string }>;
    /** Which planes the answer drew on — so the UI/answer can never look at one and imply both. */
    planes: { events: number; governance: number };
    /** Wave 3b · the cards the operator pinned to this question (count + their titles/statuses). */
    pinned_total: number;
    pinned: Array<{ summary: string; status: string }>;
    /** Plane-B (governance) breakdown, mirroring the project board's lanes. */
    governance: {
      total: number;
      waiting_owner: number;
      running: number;
      blocked: number;
      healthy: number;
    };
    /** Plane C (P1) · documents the answer can ground on (count + filenames; excerpts go only to the model). */
    documents: { total: number; names: string[] };
    /** Source connection truth, separate from operation_events setup reminders. */
    sources: {
      total: number;
      connected: number;
      errored: number;
      unbound: number;
      providers: Array<{
        provider: string;
        status: string;
        workspace_binding: string;
        last_sync_at: string | null;
        last_sync_error: string | null;
        event_count: number;
        latest_event_at: string | null;
      }>;
    };
    /** P0.1 (260706) · data-freshness guard (HR-EVIDENCE-BOUND-ASSERTION-1 C8): the age of the newest
     *  grounded event. The chief-of-staff must never imply "all clear / real-time" from a stale record —
     *  a confident answer over 6-day-old data is worse than none. The UI surfaces this; the model is told. */
    data_freshness: {
      newest_event_at: string | null;
      staleness_minutes: number | null;
      is_stale: boolean;
    };
    /** P0.4 · resolved agent identities present in the grounded events (agent_id -> role + skills, from
     *  agent-roles.yml). Lets the answer name WHICH governed agent acted; 'unregistered' flags an
     *  agent_id with no contract entry (a drift signal). Empty when only human/operator activity. */
    agents: Array<{ agent_id: string; role: string; skills: string[] }>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Plane B · the governance plane (operations-live-stream packets / decisions)
//
// The cockpit chat historically read ONLY operation_events (Plane A: github +
// activity webhooks). The project board reads a SECOND plane — the MB-P
// operations-live-stream snapshot (Plane B: governance packets/decisions waiting
// on the owner). The two never met, so the chat answered "nothing blocked" while
// the same board showed packets "waiting · owner" and a decision "running". These
// helpers map Plane-B rows into the SAME HarnessFlowEvent shape the chat already
// grounds on, so ONE answer covers both planes. The row→state classifier MIRRORS
// the board's stateForProjectRowDPS (DetailedProjectShellDesign.jsx) EXACTLY, and
// the scope match MIRRORS scopedRowsDPS (project OR workspace OR domain) — so the
// chat and the board the operator is looking at always agree.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal, superset-tolerant shape of an operations-live-stream row we rely on. */
export interface GovernanceStreamRow {
  row_id?: string;
  stream_type?: string;
  type?: string;
  state?: string;
  status?: string;
  workspace_id?: string;
  project_id?: string;
  domain_id?: string;
  domain?: string;
  timestamp_iso?: string;
  title?: string;
  body?: string;
  summary?: string;
  source_adapter?: string;
  evidence_refs?: Array<{ uri?: string | null; label?: string }>;
}

/** A Plane-B row mapped into the Plane-A event shape, tagged with its plane. */
export type GovernanceMappedEvent = HarnessFlowEvent & {
  _plane: 'governance';
  _stream_type: string;
};

/** Normalize an id for tolerant cross-plane comparison (lowercase, strip non-alnum). */
const normId = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Board-identical regexes (DetailedProjectShellDesign.jsx): blocked keys off the bare state
// (stateForProjectRowDPS); "needs you / waiting · owner" keys off the row HAYSTACK
// (LANE_MATCHERS_DPS.needs_you) — which is why an evidence-ready packet TITLED "Owner confirmation…"
// is shown as "waiting · owner" even though its bare state is not a review state.
const GOV_BLOCKED_STATE = /blocked|fail|risk|stale|red/i;

/** P0.1 · a grounded record whose newest event is older than this is flagged stale (HR-EVIDENCE-BOUND C8).
 *  60 min: the chief-of-staff answers about "current" work; older than an hour, it must say how old. */
const STALE_THRESHOLD_MINUTES = 60;

/** P0.4 · agent identity -> {role, skills} for lineage answers. Mirrors docs/contracts/agent-roles.yml
 *  (the SSOT; kept in parity by scripts/verify-agent-roles-parity.mjs). Lets the chat name WHICH governed
 *  agent (role + capabilities) acted on the record, not just an opaque agent_id — closing the audit gap
 *  where lineage showed "who" as a raw string with no role/skill context. */
const AGENT_ROLE_REGISTRY: Record<string, { role: string; skills: string[] }> = {
  'xlooop:operations-executor': { role: 'executor', skills: ['queue-drain', 'governed-proposal'] },
  'xlooop:digest-agent': { role: 'drafter', skills: ['workspace-digest'] },
  'xlooop:roadmap-agent': { role: 'drafter', skills: ['workspace-roadmap'] },
};
const GOV_NEEDS_OWNER = /owner|needs|blocked|required|review|confirm|waiting|queued|sign[- ]?off/i;
const GOV_HEALTHY = /approved|pass|done|closed|merged/i;

/** The board's row haystack (rowHaystackDPS): the fields the needs_you lane matcher scans. */
function governanceHaystack(row: GovernanceStreamRow): string {
  return [row.title, row.body, row.summary, row.type, row.stream_type, row.source_adapter, row.project_id, row.domain]
    .filter(Boolean)
    .join(' ');
}

/**
 * Board-identical row → coarse state. MUST stay in lockstep with the project board
 * (DetailedProjectShellDesign.jsx) so the chat's counts match the cards the operator sees:
 * blocked (bare state) → "blocked"; needs-you haystack → "waiting · owner"; else healthy/running.
 */
export function classifyGovernanceRow(row: GovernanceStreamRow): 'blocked' | 'needsrev' | 'running' | 'approved' {
  const state = String(row?.state || row?.status || '').toLowerCase();
  if (GOV_BLOCKED_STATE.test(state)) return 'blocked';
  if (GOV_NEEDS_OWNER.test(governanceHaystack(row))) return 'needsrev';
  if (GOV_HEALTHY.test(state || String(row?.stream_type || '').toLowerCase())) return 'approved';
  return 'running';
}

const GOV_STATE_TO_EVENT_STATUS: Record<string, EventStatus> = {
  blocked: 'blocked',
  needsrev: 'needs_review',
  running: 'running',
  approved: 'approved',
};

/**
 * Is a governance row in the chat's scope? MOST-SPECIFIC scope wins, mirroring the project board the
 * operator is looking at: a focused PROJECT shows that project's rows ONLY — which is what reproduces
 * the exact cards the operator sees (e.g. project 'mbp-governance' → the 5 packets "waiting · owner"),
 * NOT a 50-row whole-workspace dump. Then domain. Then whole-workspace (when neither project nor
 * domain is focused). An unrelated tenant workspace (e.g. 'org_3EG82…') shares no id and matches none.
 *
 * ARCH-006 W1.1 (HR-SCOPE-SYMMETRY-1): `operatorWide` makes the operator-wide ("All my workspaces")
 * scope honor the SAME plane the operator-wide Plane A read already spans. Plane A (`listEventsForOperator`)
 * is operator-wide by construction (owner_user_id = ANY(operatorIds)); without this flag Plane B would
 * hard-fail every row → the asymmetry that made the chief-of-staff answer "0 blocked" while real blockers
 * sat in another owned workspace. The govRows handed in are the operator's OWN live-stream/operations_unified
 * snapshot (operator-owned data), so returning true for all of them in operator-wide mode mirrors Plane A
 * exactly. Default `false` keeps every existing caller/test byte-identical.
 */
export function governanceRowInScope(
  row: GovernanceStreamRow,
  scope: CockpitChatScope,
  operatorWide = false,
): boolean {
  const rowP = normId(row.project_id);
  const rowW = normId(row.workspace_id);
  const rowD = normId(row.domain_id || row.domain);
  const pid = normId(scope.project_id);
  const did = normId(scope.domain_id);
  const wid = normId(scope.workspace_id);
  if (pid) return !!rowP && rowP === pid;
  if (did) return !!rowD && rowD === did;
  if (wid) return !!rowW && rowW === wid;
  return operatorWide;
}

/**
 * Map scoped governance rows → events in the shared HarnessFlowEvent shape. Pure + deterministic.
 * `needsrev` rows carry approval_state 'pending' + next_action 'owner_sign_off' so the same counters
 * that surface operation_events sign-offs also surface governance ones.
 */
export function mapGovernanceRowsToEvents(
  rows: GovernanceStreamRow[] | null | undefined,
  scope: CockpitChatScope,
  operatorWide = false,
): GovernanceMappedEvent[] {
  const list = Array.isArray(rows) ? rows : [];
  const out: GovernanceMappedEvent[] = [];
  for (const row of list) {
    if (!row || !governanceRowInScope(row, scope, operatorWide)) continue;
    const cls = classifyGovernanceRow(row);
    const status = GOV_STATE_TO_EVENT_STATUS[cls] || 'running';
    const evidence = Array.isArray(row.evidence_refs)
      ? (row.evidence_refs.find((r) => r && r.uri)?.uri ?? null)
      : null;
    const title = clip(row.title || row.summary, 200);
    out.push({
      id: String(row.row_id || `gov_${out.length}`),
      workspace_id: String(row.workspace_id || scope.workspace_id || ''),
      project_id: row.project_id ? String(row.project_id) : (scope.project_id ?? null),
      source_tool: 'mbp',
      agent_id: row.source_adapter ? `mbp:${String(row.source_adapter)}` : 'mbp:operations-live-stream',
      intent_id: null,
      status,
      summary: title,
      body: row.summary && row.title && row.summary !== row.title ? clip(row.summary, 400) : null,
      evidence_link: evidence ? String(evidence) : null,
      visibility: 'internal_owner_only',
      permission_scope: null,
      risk: null,
      approval_state: cls === 'needsrev' ? 'pending' : null,
      next_action: cls === 'needsrev' ? 'owner_sign_off' : null,
      occurred_at: String(row.timestamp_iso || ''),
      _plane: 'governance',
      _stream_type: String(row.stream_type || 'governance'),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 3b · pinned context cards — events/packets the operator clicked into the chat to ground a
// question on (possibly from other scopes). The cockpit already HAS the row data when the operator
// attaches it, so the frontend sends the card fields and we map them into the shared event shape.
// ─────────────────────────────────────────────────────────────────────────────

/** A context card as the cockpit sends it (tolerant: board-state or event-status, any scope). */
export interface ContextCardInput {
  id?: string;
  title?: string;
  summary?: string;
  status?: string;
  state?: string;
  source?: string;
  source_tool?: string;
  workspace_id?: string;
  project_id?: string;
  occurred_at?: string;
}

/** Map a pinned card's loose status/state (board lane OR event status) to a real EventStatus. */
function cardStatusToEventStatus(s: unknown): EventStatus {
  const v = String(s ?? '').toLowerCase();
  if (/block|fail|risk|stale|\bred\b/.test(v)) return 'blocked';
  if (/needsrev|needs_review|review|sign[- ]?off|owner|pending|waiting|confirm/.test(v)) return 'needs_review';
  if (/approved|\bpass\b|done|complete|healthy|closed|merged/.test(v)) return 'completed';
  if (/running|queued|active|progress/.test(v)) return 'running';
  return 'needs_review'; // a pinned card is, by default, something the operator wants to act on
}

const VALID_CARD_SOURCE: ReadonlySet<string> = new Set(['codex', 'claude', 'harness', 'mbp', 'xlooop', 'operator', 'github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive']);

/** Map the operator's pinned cards into events. Bounded (max 12), tolerant of partial input. */
export function mapContextCardsToEvents(cards: ContextCardInput[] | null | undefined): HarnessFlowEvent[] {
  const list = Array.isArray(cards) ? cards : [];
  const out: HarnessFlowEvent[] = [];
  for (let i = 0; i < list.length && out.length < 12; i += 1) {
    const c = list[i];
    if (!c || typeof c !== 'object') continue;
    const summary = clip(c.title || c.summary, 200);
    if (!summary) continue;
    const src = String(c.source_tool || c.source || 'operator');
    out.push({
      id: String(c.id || `pin_${i}`),
      workspace_id: String(c.workspace_id || ''),
      project_id: c.project_id ? String(c.project_id) : null,
      source_tool: (VALID_CARD_SOURCE.has(src) ? src : 'operator') as HarnessFlowEvent['source_tool'],
      agent_id: null,
      intent_id: null,
      status: cardStatusToEventStatus(c.status || c.state),
      summary,
      body: c.summary && c.title && c.summary !== c.title ? clip(c.summary, 400) : null,
      evidence_link: null,
      visibility: 'internal_owner_only',
      permission_scope: null,
      risk: null,
      approval_state: null,
      next_action: null,
      occurred_at: String(c.occurred_at || ''),
    });
  }
  return out;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Short, human time-ago for grounding ("2h ago", "3d ago"). Defensive on bad input. */
function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** Trim a possibly-long event summary to a scannable line. */
function clip(s: string | null | undefined, max = 140): string {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/**
 * Compile grounding facts from a list of scoped events. Pure + deterministic — the single source of
 * truth the deterministic body AND the LLM prompt both draw from, so the model can only restate real
 * numbers/names. `total` lets the caller report the true scope size even when `events` is capped.
 */
export function compileChatFacts(facts: CockpitChatFacts): CockpitChatResult['grounded_on'] {
  const docs = Array.isArray(facts.documents) ? facts.documents : [];
  const sourceFacts = Array.isArray(facts.sources) ? facts.sources : [];
  const pinned = Array.isArray(facts.pinned) ? facts.pinned : [];
  const planeA = Array.isArray(facts.events) ? facts.events : [];
  const planeB = Array.isArray(facts.governance) ? facts.governance : [];
  // Wave 3b · pinned cards lead, then the scoped record. Dedupe the scoped planes against the pinned
  // ids so an event the operator pinned isn't also double-counted from the scope.
  const pinnedIds = new Set(pinned.map((e) => normId(e && e.id)).filter(Boolean));
  const scopedUnion = [...planeA, ...planeB].filter((e) => !pinnedIds.has(normId(e && e.id)));
  // The union is the single thing every count below is drawn from — so the answer can never see
  // one plane and imply the other (the exact bug: "0 blocked" while the board showed governance).
  const events = [...pinned, ...scopedUnion];
  // W1 · the grounded ids, EXACTLY the union the counts below are drawn from (pinned-first, deduped).
  const event_ids = events.map((e) => normId(e && e.id)).filter(Boolean).slice(0, 200) as string[];
  const now = Date.now();

  // P0.1 · data-freshness: the newest grounded event's age. Computed over ALL grounded planes so the
  // answer can never look current when the record is stale (HR-EVIDENCE-BOUND-ASSERTION-1 C8).
  const newestMs = [...planeA, ...planeB, ...pinned].reduce((mx, e) => {
    const t = Date.parse(String((e && e.occurred_at) || ''));
    return Number.isFinite(t) && t > mx ? t : mx;
  }, 0);
  const newest_event_at = newestMs > 0 ? new Date(newestMs).toISOString() : null;
  const staleness_minutes = newestMs > 0 ? Math.max(0, Math.round((now - newestMs) / 60000)) : null;
  const data_freshness = {
    newest_event_at,
    staleness_minutes,
    is_stale: staleness_minutes != null && staleness_minutes > STALE_THRESHOLD_MINUTES,
  };

  // P0.4 · resolve the distinct AGENT identities that acted on the grounded events to their role+skills,
  // so the answer/UI can say WHICH governed agent acted (not just an opaque id). Human/operator activity
  // (no agent_id) contributes nothing here.
  const agentIds = new Set<string>();
  for (const e of [...planeA, ...planeB, ...pinned]) {
    const a = e && (e as { agent_id?: string | null }).agent_id;
    if (a) agentIds.add(String(a));
  }
  const agents = [...agentIds].map((agent_id) => {
    const reg = AGENT_ROLE_REGISTRY[agent_id];
    return { agent_id, role: reg ? reg.role : 'unregistered', skills: reg ? reg.skills : [] };
  });

  const byStatus = (s: string) => events.filter((e) => e && e.status === s).length;
  const completed = byStatus('completed') + byStatus('approved');
  const blocked = byStatus('blocked') + byStatus('failed');
  const needs_review = events.filter((e) => e && (e.status === 'needs_review' || e.approval_state === 'pending')).length;
  const in_progress = byStatus('running') + byStatus('queued');

  const sourceCounts = new Map<string, number>();
  for (const e of events) {
    const src = String((e && e.source_tool) || 'unknown');
    sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
  }
  const top_sources = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  // Pinned cards lead the named list (in attach order), then the most-recent scoped items by time.
  const toLine = (e: HarnessFlowEvent) => ({
    summary: clip(e && e.summary),
    status: String((e && e.status) || 'unknown'),
    when: timeAgo(String((e && e.occurred_at) || ''), now),
  });
  const sortedScoped = [...scopedUnion]
    .sort((a, b) => Date.parse(String((b && b.occurred_at) || '')) - Date.parse(String((a && a.occurred_at) || '')));
  const recent = [...pinned, ...sortedScoped].slice(0, NAMED_RECENT).map(toLine);
  const pinnedLines = pinned.map(toLine).map((l) => ({ summary: l.summary, status: l.status }));

  // Plane-B breakdown, mirroring the project board's lanes (waiting·owner / running / blocked / healthy).
  const govBy = (pred: (e: GovernanceMappedEvent) => boolean) => planeB.filter((e) => e && pred(e)).length;
  const governance = {
    total: planeB.length,
    waiting_owner: govBy((e) => e.status === 'needs_review' || e.approval_state === 'pending'),
    running: govBy((e) => e.status === 'running' || e.status === 'queued'),
    blocked: govBy((e) => e.status === 'blocked' || e.status === 'failed'),
    healthy: govBy((e) => e.status === 'approved' || e.status === 'completed'),
  };

  // Scope total = Plane-A scope total (may exceed the recency-capped page) + Plane-B rows on record.
  const planeATotal = Number.isFinite(facts.total) ? facts.total : planeA.length;

  return {
    event_ids,
    events_considered: events.length,
    events_total: planeATotal + planeB.length,
    completed,
    in_progress,
    blocked,
    needs_review,
    top_sources,
    recent,
    planes: { events: planeA.length, governance: planeB.length },
    pinned_total: pinned.length,
    pinned: pinnedLines,
    governance,
    documents: { total: docs.length, names: docs.slice(0, 8).map((d) => String(d.filename ?? '').slice(0, 120)) },
    sources: {
      total: sourceFacts.length,
      connected: sourceFacts.filter((s) => s && s.status === 'connected').length,
      errored: sourceFacts.filter((s) => s && s.status === 'error').length,
      unbound: sourceFacts.filter((s) => s && s.workspace_binding === 'legacy_user_account_unbound').length,
      providers: sourceFacts.slice(0, 12).map((s) => ({
        provider: String(s.provider || 'unknown'),
        status: String(s.status || 'unknown'),
        workspace_binding: String(s.workspace_binding || 'legacy_user_account_unbound'),
        last_sync_at: s.last_sync_at ?? null,
        last_sync_error: s.last_sync_error ?? null,
        event_count: Number.isFinite(s.event_count) ? s.event_count : 0,
        latest_event_at: s.latest_event_at ?? null,
      })),
    },
    data_freshness,
    agents,
  };
}

/** A label for the scope, customer-safe ("this project", "this workspace", "this domain"). */
function scopeLabel(scope: CockpitChatScope): string {
  if (scope.project_id) return 'this project';
  if (scope.domain_id) return 'this domain';
  return 'this workspace';
}

/**
 * Deterministic, GROUNDED answer over the real events. Not a canned string — it is assembled from
 * the actual counts, statuses, top sources, and most-recent named items. Genuinely useful as a
 * standalone digest, and the guaranteed fallback when no LLM binding is present (or it fails).
 * Lightly tailored to the operator's question (blocked/sign-off intent surfaces those first).
 */
/** A short, customer-facing summary of the captured company profile (S1) so the deterministic floor
 *  is COMPANY-AWARE even when the LLM is unavailable. Returns '' when nothing is captured. */
function companyContextSummary(c?: import('../dal/customer-context-store').CustomerContextProfile | null): string {
  if (!c || c.provenance === 'none') return '';
  const bits: string[] = [];
  if (c.company && c.company.name) bits.push(`This is ${c.company.name}`);
  if (c.focus_90d) bits.push(`90-day focus: "${c.focus_90d}"`);
  if (c.growth_posture) bits.push(`over the next year, looking to ${String(c.growth_posture).toLowerCase()}`);
  if (c.maturity_level) bits.push(`AI-readiness ${c.maturity_level}`);
  if (Array.isArray(c.ai_tools_in_use) && c.ai_tools_in_use.length) bits.push(`AI tools in use: ${c.ai_tools_in_use.join(', ')}`);
  if (Array.isArray(c.data_lives_in) && c.data_lives_in.length) bits.push(`work lives in: ${c.data_lives_in.join(', ')}`);
  if (Array.isArray(c.public_signals) && c.public_signals.length) bits.push(c.public_signals.join('; '));
  return bits.length ? `From your onboarding — ${bits.join('. ')}.` : '';
}

function sourceStatusLine(grounded: CockpitChatResult['grounded_on'], question: string): string | null {
  const sources = grounded.sources && Array.isArray(grounded.sources.providers) ? grounded.sources.providers : [];
  if (!sources.length) return null;
  const q = String(question || '').toLowerCase();
  const asksEmail = /\b(email|emails|mail|gmail|inbox|message|messages)\b/.test(q);
  const relevant = asksEmail
    ? sources.filter((s) => /gmail|outlook/.test(String(s.provider).toLowerCase()))
    : sources;
  if (!relevant.length) {
    if (asksEmail) return '• Source status: no Gmail or Outlook connection is recorded for this workspace.';
    return null;
  }
  const parts = relevant.map((s) => {
    const bits = [`${s.provider} ${s.status}`];
    if (s.workspace_binding === 'legacy_user_account_unbound') bits.push('legacy user-account binding');
    if (s.last_sync_error) bits.push(`last sync error: ${s.last_sync_error}`);
    else if (s.last_sync_at) bits.push(`last synced ${timeAgo(s.last_sync_at) || s.last_sync_at}`);
    if (s.event_count > 0) bits.push(`${s.event_count} ingested event${s.event_count === 1 ? '' : 's'}`);
    else bits.push('0 ingested events');
    return bits.join(', ');
  });
  return `• Source status: ${parts.join('; ')}.`;
}

export function buildDeterministicChatAnswer(
  message: string,
  grounded: CockpitChatResult['grounded_on'],
  scope: CockpitChatScope,
  mode: CockpitChatMode = 'ask',
  companyContext?: import('../dal/customer-context-store').CustomerContextProfile | null,
): string {
  const where = scopeLabel(scope);
  const q = String(message || '').toLowerCase();
  const asksBlocked = mode === 'recommend' || mode === 'plan'
    || /\b(block|blocked|stuck|sign[- ]?off|sign off|approve|approval|review|needs? you)\b/.test(q);

  if (grounded.events_total === 0 && grounded.pinned_total === 0) {
    const docNote = grounded.documents && grounded.documents.total > 0
      ? ` You do have ${plural(grounded.documents.total, 'document')} on file (${grounded.documents.names.join(', ')}) — ask me about their contents.`
      : '';
    const company = companyContextSummary(companyContext);
    const body = `There is no recorded activity in ${where} yet.${docNote} Once events start flowing in from your connected sources (or you connect your tools), ask me again and I will summarize what is happening, what is blocked, and what needs your sign-off.`;
    return company ? `${company}\n\n${body}` : body;
  }

  const gov = grounded.governance;
  const lines: string[] = [];
  const lead = modeLead(mode, where);
  if (lead) lines.push(lead, '');
  const companyLead = companyContextSummary(companyContext);
  if (companyLead) lines.push(companyLead, '');

  // Wave 3b · pinned cards lead — the answer addresses exactly what the operator attached, first.
  if (grounded.pinned_total > 0) {
    lines.push(`You pinned ${plural(grounded.pinned_total, 'item')} to this question:`);
    for (const p of grounded.pinned.slice(0, 8)) lines.push(`  – ${p.summary} [${p.status}]`);
    lines.push('');
  }

  if (grounded.events_total > 0) {
    lines.push(
      `Here is what is happening in ${where}, grounded in ${plural(grounded.events_total, 'event')} on record`
      + `${gov && gov.total > 0 ? ` (${grounded.planes.events} activity ${grounded.planes.events === 1 ? 'event' : 'events'} + ${plural(gov.total, 'governance item')})` : ''}`
      + `${grounded.events_considered < grounded.events_total ? ` (I looked at the ${grounded.events_considered} most recent)` : ''}:`,
    );
  } else {
    lines.push(`There is no other recorded activity in ${where} right now — here is what I can tell you about the pinned ${grounded.pinned_total === 1 ? 'item' : 'items'}:`);
  }

  // Status posture line.
  const statusBits: string[] = [];
  if (grounded.completed > 0) statusBits.push(`${grounded.completed} completed`);
  if (grounded.in_progress > 0) statusBits.push(`${grounded.in_progress} in progress`);
  if (grounded.needs_review > 0) statusBits.push(`${grounded.needs_review} awaiting your sign-off`);
  if (grounded.blocked > 0) statusBits.push(`${grounded.blocked} blocked`);
  if (statusBits.length) lines.push(`• Status: ${statusBits.join(' · ')}`);

  // Governance plane callout — the packets/decisions the project board shows and the chat used to be
  // blind to. Only when present, so activity-only scopes read exactly as before.
  if (gov && gov.total > 0) {
    const govBits: string[] = [];
    if (gov.waiting_owner > 0) govBits.push(`${plural(gov.waiting_owner, 'item')} waiting on your sign-off`);
    if (gov.running > 0) govBits.push(`${gov.running} running`);
    if (gov.blocked > 0) govBits.push(`${gov.blocked} blocked`);
    if (gov.healthy > 0) govBits.push(`${gov.healthy} cleared`);
    lines.push(`• Governance (packets/decisions from your operations stream): ${govBits.join(' · ') || `${plural(gov.total, 'item')} on record`}`);
  }

  // Top sources.
  if (grounded.top_sources.length) {
    lines.push(`• Most activity from: ${grounded.top_sources.map((s) => `${s.source} (${s.count})`).join(', ')}`);
  }

  // Plane C (P1) · documents on file — surface them so the deterministic floor isn't blind to docs.
  if (grounded.documents && grounded.documents.total > 0) {
    lines.push(`• Documents on file (${grounded.documents.total}): ${grounded.documents.names.join(', ')} — ask me about their contents.`);
  }

  const sourceLine = sourceStatusLine(grounded, message);
  if (sourceLine) lines.push(sourceLine);

  // Blocked / sign-off first when the operator asked for it.
  if (asksBlocked) {
    if (grounded.needs_review === 0 && grounded.blocked === 0) {
      lines.push('• Nothing is blocked and nothing is awaiting your sign-off right now — you are clear.');
    } else {
      if (grounded.needs_review > 0) lines.push(`• ${plural(grounded.needs_review, 'item')} need your sign-off.`);
      if (grounded.blocked > 0) lines.push(`• ${plural(grounded.blocked, 'item')} blocked and need attention.`);
    }
  }

  // Named recent items — this is what makes it concretely grounded.
  if (grounded.recent.length) {
    lines.push('', 'Most recent:');
    for (const r of grounded.recent.slice(0, 5)) {
      const when = r.when ? ` · ${r.when}` : '';
      lines.push(`  – ${r.summary} [${r.status}]${when}`);
    }
  }

  return lines.join('\n');
}

/**
 * Answer a cockpit-chat question grounded in the scoped events. LLM-richer via the Workers-AI
 * binding when present; deterministic grounded digest otherwise / on any failure. NEVER throws
 * (HR-INPUT-COERCION-NO-THROW-1 spirit) and NEVER invents — the model is fed ONLY the compiled
 * facts and instructed to restate, not invent. Bounded tokens.
 */
/**
 * P6 · call Claude via the Anthropic Messages API. Returns the text, or null on ANY failure / non-200 /
 * empty body — the caller then falls back to Llama → deterministic. NEVER throws. Grounded prompt only
 * (same no-invention fact sheet as the Llama path); bounded tokens.
 */
async function callClaude(
  apiKey: string,
  system: string,
  user: string,
): Promise<{ text: string; usage?: { input_tokens?: number; output_tokens?: number } } | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: COCKPIT_CHAT_CLAUDE_MODEL,
        max_tokens: 700,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) return null;
    // G2 (260711) · usage was previously parsed away here — the Messages API carries top-level
    // usage:{input_tokens,output_tokens}; surface it for per-tenant metering.
    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = Array.isArray(data?.content)
      ? data.content.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '')).join('').trim()
      : '';
    return text.length > 0 ? { text, usage: data.usage } : null;
  } catch (_) {
    return null;
  }
}

// ARCH-006 W3 — structured-fact grounding (the case-11 moat). In ADDITION to the prose fact sheet, hand
// the model a compact, TYPED projection of the SAME scoped facts as JSON. Structured context lifts
// small-model accuracy and lets the model reason over specific records (which item is blocked, its
// project, whether it needs the operator) instead of parsing prose. Bounded + null-stripped to control
// tokens; the prose remains the robustness layer — the model reads both and may never invent fields.
function buildStructuredFactBlock(facts: CockpitChatFacts, grounded: CockpitChatResult['grounded_on']): string {
  const STRUCT_CAP = 30;
  const toItem = (e: Record<string, unknown> | null | undefined, plane: string): Record<string, unknown> => {
    const it: Record<string, unknown> = {
      id: String((e && e.id) ?? '').slice(0, 80),
      plane,
      status: (e && e.status) ?? null,
      summary: String((e && e.summary) ?? '').slice(0, 160),
    };
    if (e && e.project_id) it.project_id = String(e.project_id);
    if (e && e.intent_id) it.intent_id = String(e.intent_id);
    if (e && (e as { domain_id?: unknown }).domain_id) it.domain_id = String((e as { domain_id?: unknown }).domain_id);
    if (e && e.occurred_at) it.occurred_at = String(e.occurred_at);
    if (e && (e.status === 'needs_review' || e.approval_state === 'pending')) it.needs_you = true;
    return it;
  };
  const planeA = Array.isArray(facts.events) ? facts.events : [];
  const planeB = Array.isArray(facts.governance) ? facts.governance : [];
  const pinned = Array.isArray(facts.pinned) ? facts.pinned : [];
  const items = [
    ...pinned.map((e) => ({ ...toItem(e as unknown as Record<string, unknown>, 'pinned'), pinned: true })),
    ...planeA.map((e) => toItem(e as unknown as Record<string, unknown>, 'event_sourcing')),
    ...planeB.map((e) => toItem(e as unknown as Record<string, unknown>, 'governance')),
  ].slice(0, STRUCT_CAP);
  const block: Record<string, unknown> = {
    scope: scopeLabel(facts.scope),
    rollup: {
      total: grounded.events_total, events: grounded.planes.events, governance: grounded.planes.governance,
      completed: grounded.completed, in_progress: grounded.in_progress, needs_review: grounded.needs_review, blocked: grounded.blocked,
    },
    items,
  };
  if (grounded.governance.total > 0) {
    block.governance = {
      waiting_owner: grounded.governance.waiting_owner, running: grounded.governance.running,
      blocked: grounded.governance.blocked, healthy: grounded.governance.healthy,
    };
  }
  // OS-4 P4 · GRAPH lineage around the PINNED cards — the first time the model sees the graph.
  // Compact typed edges (cap 20): from -[edge_type]-> to, with descriptions for legibility and
  // is_cause_edge marking the RCA direction. Absent/[] => the block is byte-identical to before.
  const lineage = Array.isArray(facts.lineage) ? facts.lineage : [];
  if (lineage.length > 0) {
    block.lineage = lineage.slice(0, 20).map((l) => ({
      from: String(l.edge_from).slice(0, 80),
      from_desc: String(l.from_description ?? '').slice(0, 100) || undefined,
      edge: l.edge_type,
      to: String(l.edge_to).slice(0, 80),
      to_desc: String(l.to_description ?? '').slice(0, 100) || undefined,
      ...(l.is_cause_edge ? { cause: true } : {}),
    }));
  }
  // Plane C (P1) · uploaded documents — the model grounds answers in the customer's own doc text.
  const planeC = Array.isArray(facts.documents) ? facts.documents : [];
  if (planeC.length > 0) {
    block.documents = planeC.slice(0, 8).map((d) => ({
      filename: String(d.filename ?? '').slice(0, 120),
      excerpt: String(d.excerpt ?? '').slice(0, 1200),
    }));
  }
  if (grounded.sources.total > 0) {
    block.sources = grounded.sources.providers.map((s) => ({
      provider: s.provider,
      status: s.status,
      workspace_binding: s.workspace_binding,
      last_sync_at: s.last_sync_at,
      last_sync_error: s.last_sync_error,
      ingested_event_count: s.event_count,
      latest_event_at: s.latest_event_at,
    }));
  }
  return JSON.stringify(block);
}

/** User-selectable chat LLM. 'llama' = free Workers-AI default; 'claude' = premium (needs ANTHROPIC_API_KEY). */
export type CockpitChatLLM = 'llama' | 'claude';

export async function answerCockpitChat(
  message: string,
  facts: CockpitChatFacts,
  ai?: AiRunner,
  mode: CockpitChatMode = 'ask',
  claudeKey?: string,
  llmChoice: CockpitChatLLM = 'llama',
  executionObserver?: ModelExecutionObserver,
): Promise<CockpitChatResult> {
  const grounded = compileChatFacts(facts);
  // P0.1 · the deterministic FLOOR must be honest about staleness too (it is the guaranteed fallback).
  const staleNote = grounded.data_freshness.is_stale
    ? `Note: this record's newest activity is ${grounded.data_freshness.staleness_minutes} minutes old — treat the below as a snapshot, not live status.\n\n`
    : '';
  const deterministic = staleNote + buildDeterministicChatAnswer(message, grounded, facts.scope, mode, facts.companyContext);

  // Build the grounded fact sheet + prompts ONCE — shared verbatim by the Claude (premium) and Llama paths
  // so neither can invent beyond the supplied facts.
  const where = scopeLabel(facts.scope);
  const factLines: string[] = [
    `Scope: ${where}.`,
    `Total items on record: ${grounded.events_total} (${grounded.planes.events} activity events + ${grounded.planes.governance} governance packets/decisions; I am giving you the ${grounded.events_considered} most recent).`,
    `Status counts (both planes) — completed: ${grounded.completed}; in progress: ${grounded.in_progress}; awaiting the operator's sign-off: ${grounded.needs_review}; blocked: ${grounded.blocked}.`,
  ];
  // Wave 3b · pinned cards FIRST — these are exactly what the operator attached; address them up front.
  if (grounded.pinned_total > 0) {
    factLines.unshift(
      `PINNED items the operator attached to THIS question (address these first, they may be from other scopes):`
      + grounded.pinned.map((p, i) => `\n  P${i + 1}. "${p.summary}" — status ${p.status}.`).join(''),
    );
  }
  // OS-4 P4 · the graph lineage around the pinned items, in prose (the robustness layer; the same
  // edges appear typed in the structured block). Lets the model answer "what led to this / what does
  // it realize" from the REAL graph instead of guessing.
  const lineageEdges = Array.isArray(facts.lineage) ? facts.lineage : [];
  if (lineageEdges.length > 0) {
    factLines.push(
      `LINEAGE around the pinned items (from the temporal graph; "caused_by" = the cause direction):`
      + lineageEdges.slice(0, 12).map((l) => `\n  ${l.from_description || l.edge_from} -[${l.edge_type}]-> ${l.to_description || l.edge_to}`).join(''),
    );
  }
  if (grounded.governance.total > 0) {
    const g = grounded.governance;
    factLines.push(
      `Governance plane (packets/decisions the operator must act on): ${g.total} total — `
      + `${g.waiting_owner} waiting on the operator's sign-off, ${g.running} running, ${g.blocked} blocked, ${g.healthy} cleared.`,
    );
  }
  if (grounded.top_sources.length) {
    factLines.push(`Activity by source: ${grounded.top_sources.map((s) => `${s.source}=${s.count}`).join(', ')}.`);
  }
  if (grounded.sources.total > 0) {
    factLines.push(
      `Connected source truth (authoritative over setup-reminder events): `
      + grounded.sources.providers.map((s) => {
        const sync = s.last_sync_error ? `last_sync_error=${s.last_sync_error}` : `last_sync_at=${s.last_sync_at || 'null'}`;
        return `${s.provider} status=${s.status} binding=${s.workspace_binding} ${sync} ingested_events=${s.event_count} latest_event_at=${s.latest_event_at || 'null'}`;
      }).join('; '),
    );
  }
  if (grounded.recent.length) {
    factLines.push('Most recent events (newest first):');
    grounded.recent.forEach((r, i) => {
      factLines.push(`  ${i + 1}. "${r.summary}" — status ${r.status}${r.when ? `, ${r.when}` : ''}.`);
    });
  }
  // Plane C (P1) · uploaded documents in the PROSE too (parity with the structured block) so the model can
  // answer FROM the customer's own doc text, not just events. Closes the pilot's "how do I add docs" felt gap.
  const planeCDocs = Array.isArray(facts.documents) ? facts.documents.filter((d) => d && typeof d.excerpt === 'string' && d.excerpt.trim().length > 0) : [];
  if (planeCDocs.length > 0) {
    factLines.push(`Uploaded documents the operator can ask you about (${planeCDocs.length}); answer FROM their content when relevant:`);
    planeCDocs.slice(0, 8).forEach((d, i) => {
      factLines.push(`  Doc ${i + 1}: "${String(d.filename).slice(0, 120)}" — ${String(d.excerpt).slice(0, 600).replace(/\s+/g, ' ').trim()}`);
    });
  }
  const systemPrompt =
    companyContextPreamble(facts.companyContext ?? null) + ' '
    + 'Answer the operator\'s question about their work using ONLY the event facts and any uploaded documents provided below — never invent '
    + 'numbers, names, events, clients, or statuses, and never speculate beyond the facts. Be specific: cite the '
    + 'real counts and name the relevant recent items. Professional, plain, customer-safe English; no internal '
    + 'jargon, no markdown headings. 3 to 6 short sentences. If the facts do not answer the question, say so '
    + 'plainly and report what the record does show.'
    // Product capabilities (260702) · "how do I …?" questions ask HOW to do something in the product — they are
    // about capabilities, NOT the event record. Do not answer "the record does not cover it" and NEVER deflect to
    // support for something the product does. State the capability directly (a product fact, not an invention).
    + ' IMPORTANT: if the question asks HOW to do something in the product (e.g. "how do I add documents / upload '
    + 'a file / connect a source / add a goal / get a sign-off / invite someone?"), it is about a capability, not '
    + 'the event record — so do NOT say the record does not cover it, and NEVER tell the user to contact support. '
    + 'Point them to the in-product surface: to add/upload documents or connect a source, use the "Add documents" '
    + 'card in this chat ("Upload a file" for PDF/text/markdown/CSV/JSON up to 5 MB, or Google Drive / GitHub / '
    + 'Dropbox / local folder); for goals, plans, sign-offs and approvals, use this chat and the cockpit around it.'
    // P0.1 · freshness honesty (HR-EVIDENCE-BOUND C8): if the record is stale, the model MUST say how old it is.
    + (grounded.data_freshness.is_stale
        ? ` IMPORTANT: the newest activity on this record is ${grounded.data_freshness.staleness_minutes} minutes old`
          + ` (as of ${grounded.data_freshness.newest_event_at}). State that age plainly and do NOT imply the record`
          + ` is current or real-time — a confident "all clear" over stale data is a trust failure.`
        : '')
    + modeDirective(mode);
  // ARCH-006 W3 — typed structured facts alongside the prose (the structured-context moat). The model
  // reasons over the records for per-item precision; the prose above is the same data, summarized.
  const structuredBlock = buildStructuredFactBlock(facts, grounded);
  const userPrompt = `Event facts:\n${factLines.join('\n')}\n\nStructured facts (typed records of the SAME items — reason over these for precise, per-item answers; never invent fields):\n${structuredBlock}\n\nOperator question: ${String(message || '').slice(0, 600)}`;

  // Claude is the PRIMARY LLM whenever ANTHROPIC_API_KEY is configured (a worker secret) — for EVERY
  // read mode, not just deep-research. This makes the chat genuinely generative + high-quality (the
  // model the product is built around). The Workers-AI Llama below is the free fallback, and the
  // company-aware deterministic floor is the final fallback. Claude failure/short answer falls through.
  // Claude is used ONLY when the user explicitly selects it (or in deep-research mode) AND a key is set.
  // The default is the free Workers-AI Llama (below). Claude failure falls through to Llama → deterministic.
  if (claudeKey && (llmChoice === 'claude' || mode === 'deep-research')) {
    const startedAt = Date.now();
    const execution = await executionObserver?.start({ provider: 'anthropic', model_key: COCKPIT_CHAT_CLAUDE_MODEL });
    const claude = await callClaude(claudeKey, systemPrompt, userPrompt);
    if (claude && claude.text.length >= 40) {
      await execution?.complete({
        status: 'completed',
        tokens_in: claude.usage?.input_tokens ?? null,
        tokens_out: claude.usage?.output_tokens ?? null,
        latency_ms: Date.now() - startedAt,
        error_code: null,
      });
      return {
        answer: claude.text, generated_by: 'llm', grounded_on: grounded, model: COCKPIT_CHAT_CLAUDE_MODEL,
        // G2 · metering capture (v0 known undercount: a <40-char Claude answer falls through to Llama
        // and its tokens go unrecorded — rare, quantified by the fallthrough log line below).
        usage: { tokens_in: claude.usage?.input_tokens ?? null, tokens_out: claude.usage?.output_tokens ?? null },
      };
    }
    await execution?.complete({
      status: 'fallback', tokens_in: claude?.usage?.input_tokens ?? null,
      tokens_out: claude?.usage?.output_tokens ?? null, latency_ms: Date.now() - startedAt,
      error_code: claude ? 'SHORT_RESPONSE' : 'NO_USABLE_RESPONSE',
    });
    console.log(JSON.stringify({ kind: 'cockpit_chat_claude_fallthrough', len: claude ? claude.text.length : 0 }));
  }

  if (!ai) return { answer: deterministic, generated_by: 'deterministic', grounded_on: grounded, model: null };

  const startedAt = Date.now();
  const execution = await executionObserver?.start({ provider: 'workers_ai', model_key: COCKPIT_CHAT_LLM_MODEL });
  try {
    const out = await ai.run(COCKPIT_CHAT_LLM_MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 380,
    });

    const text = String(
      (out && typeof out === 'object' && 'response' in (out as Record<string, unknown>)
        ? (out as { response?: unknown }).response
        : '') ?? '',
    ).trim();
    // Too short → the model gave us nothing usable; the deterministic grounded answer is better.
    if (text.length < 40) {
      console.log(JSON.stringify({ kind: 'cockpit_chat_llm_short', model: COCKPIT_CHAT_LLM_MODEL, len: text.length,
        hasResponseField: !!(out && typeof out === 'object' && 'response' in (out as Record<string, unknown>)),
        outKeys: out && typeof out === 'object' ? Object.keys(out as Record<string, unknown>).slice(0, 6) : null }));
      await execution?.complete({
        status: 'fallback', tokens_in: null, tokens_out: null,
        latency_ms: Date.now() - startedAt, error_code: 'SHORT_RESPONSE',
      });
      return { answer: deterministic, generated_by: 'deterministic', grounded_on: grounded, model: null };
    }

    // G2 · metering capture — workers-types marks text-generation usage OPTIONAL; absent ⇒ nulls
    // (calls_count stays authoritative for volume; tokens 0/null = "unreported", not "free").
    const rawUsage = (out && typeof out === 'object' && 'usage' in (out as Record<string, unknown>))
      ? (out as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
      : undefined;
    await execution?.complete({
      status: 'completed', tokens_in: rawUsage?.prompt_tokens ?? null,
      tokens_out: rawUsage?.completion_tokens ?? null, latency_ms: Date.now() - startedAt, error_code: null,
    });
    return {
      answer: text, generated_by: 'llm', grounded_on: grounded, model: COCKPIT_CHAT_LLM_MODEL,
      usage: { tokens_in: rawUsage?.prompt_tokens ?? null, tokens_out: rawUsage?.completion_tokens ?? null },
    };
  } catch (err) {
    await execution?.complete({
      status: 'fallback', tokens_in: null, tokens_out: null,
      latency_ms: Date.now() - startedAt, error_code: 'MODEL_ERROR',
    });
    console.log(JSON.stringify({ kind: 'cockpit_chat_llm_error', model: COCKPIT_CHAT_LLM_MODEL, error: err instanceof Error ? err.message : String(err) }));
    return { answer: deterministic, generated_by: 'deterministic', grounded_on: grounded, model: null };
  }
}
