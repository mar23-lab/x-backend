// role-scoped-context.ts · G9 (260709) · THE pillar — role-templated chat context, built to §168.
//
// WHY (§164 C2/G-D · the §26 risk): what the agent knows and may ground on must be a PROJECTION of the
// asker's authority. Until now the grounding set was assembled inline at each chat call site — the operator
// plane even reads events with role:'operator' hardcoded — so nothing enforced, at prompt-assembly time,
// that a viewer's answer can't lean on owner-only facts or that an unpromoted upload stays out of context.
//
// THE CONTRACT (§168, design-seat scope; the three product decisions operator-confirmed 260709 — see
// docs/governance/DESIGN_DECISIONS_REGISTER.md D-5/D-6/D-7):
//   assembleRoleScopedContext(view, slice) → { admissibleFacts, visibleLineage, redactionProfile, auditLine }
// — the ONLY place the prompt's grounding set is built (both chat planes call it when
// CHAT_ROLE_SCOPED_CONTEXT_ENABLED is on; flag-off the call sites are byte-identical to today).
//
// The three §168 axes, server-side:
//   1. VISIBILITY (D-5 · grounding ≤ ceiling): an event grounds only if its visibility is within
//      visibilityForRole(view.role) — the SAME monotone sets the read path uses, so bundles are monotone
//      owner ⊇ operator ⊇ viewer ⊇ client by construction.
//   2. ADMISSIBILITY (D-6 · §168 acceptance: "no ref with admissibility ≠ approved in any bundle"):
//      flag-ON only 'approved' documents ground — STRICTER than the flag-off M6 rule (approved+visible;
//      lib/admissibility.ts stays the flag-off SSOT). Exception per D-6: a 'candidate' grounds ONLY the
//      asker who uploaded it (uploaded_by === view.user_id), marked { unpromoted: true }. 'excluded' and
//      others' candidates never ground. Absent/unknown admissibility defaults 'approved' (M6 stance).
//   3. AUTHORITY / EGRESS (D-7 · client = contribution-only): role 'client' gets an EMPTY bundle —
//      no events, no documents, no lineage (reason 'client_contribution_only'). Lineage additionally
//      requires the owner/operator class (the §167 U2 parity: v_artefact_lineage carries owner-only
//      descriptions and is not visibility-filtered) — a viewer keeps events/docs but loses lineage.
//
// PURE module (no I/O) — the chat-graph-context.ts precedent; cockpit-chat.ts (WARN band) must not grow.
// auditLine is the machine-readable include/exclude record the caller logs (and may surface in
// grounded_on.context_profile) — every grounding decision becomes traceable per answer.

import { visibilityForRole } from '../dal/visibility';
import type { WorkspaceRole } from '../dal/types';

/** Who is asking — the projection inputs (JWT role + user id; never a body-supplied value). */
export interface RoleContextView {
  role: string;
  user_id: string;
}

/** Structural fact shapes — the assembler needs only these fields; every other field passes through
 *  untouched (the functions are generic over the caller's real types, so nothing is widened). */
export interface GroundableEvent { visibility?: string | null }
export interface GroundableDocument { admissibility?: string | null; uploaded_by?: string | null }
export type GroundedDocument<D extends GroundableDocument = GroundableDocument> = D & { unpromoted?: true };

export interface RedactionProfile {
  /** 'full' = facts flow to the prompt as-is · 'none' = empty bundle (client contribution-only). */
  expose: 'full' | 'none';
  /** true when any client egress must pass neutralize invariants (names→roles, ids/receipts stripped). */
  neutralize: boolean;
}

export interface ContextAuditLine {
  role: string;
  ceiling: readonly string[];
  events: { considered: number; grounded: number; excluded_by_visibility: number };
  documents: { considered: number; grounded: number; excluded_by_admissibility: number; candidate_flagged: number };
  lineage: { considered: number; grounded: number };
  /** T1/P3 (260710) · source-state facts are ops-internal (internal_workspace-class) — counted when passed. */
  sources?: { considered: number; grounded: number };
  reason?: 'client_contribution_only';
}

export interface RoleScopedContext<E extends GroundableEvent, D extends GroundableDocument, L, S = unknown> {
  admissibleFacts: { events: E[]; documents: GroundedDocument<D>[] };
  visibleLineage: L[];
  /** T1/P3 (260710) · source connection/sync facts AFTER the authority projection. Source state is
   *  ops-internal (internal_workspace-class): owner/operator ground on it; viewer/client do not —
   *  conservative, monotone, and matching how a missing event visibility is classed (line ~112). */
  visibleSources: S[];
  redactionProfile: RedactionProfile;
  auditLine: ContextAuditLine;
}

const OPERATOR_CLASS = new Set(['owner', 'operator']);
const KNOWN_ROLES = new Set(['owner', 'operator', 'viewer', 'client']);

/** §168 axis 2, flag-ON: may this document ground THIS asker? */
function docDecision(d: GroundableDocument, askerId: string): 'approved' | 'candidate_own' | 'out' {
  const adm = typeof d.admissibility === 'string' && d.admissibility ? d.admissibility : 'approved'; // M6 default
  if (adm === 'approved') return 'approved';
  if (adm === 'candidate' && !!askerId && String(d.uploaded_by || '') === askerId) return 'candidate_own';
  return 'out'; // 'visible' (flag-on strict), 'excluded', and others' candidates never ground
}

export function assembleRoleScopedContext<E extends GroundableEvent, D extends GroundableDocument, L, S = unknown>(
  view: RoleContextView,
  slice: { events?: readonly E[]; documents?: readonly D[]; lineage?: readonly L[]; sources?: readonly S[] },
): RoleScopedContext<E, D, L, S> {
  const events = slice.events ?? [];
  const documents = slice.documents ?? [];
  const lineage = slice.lineage ?? [];
  const sources = slice.sources ?? [];
  // Unknown role → the safest known projection ('client', the empty bundle). Fail closed, never widen.
  const role = KNOWN_ROLES.has(view.role) ? view.role : 'client';

  // D-7 · client = contribution-only: no grounded spine at all.
  if (role === 'client') {
    return {
      admissibleFacts: { events: [], documents: [] },
      visibleLineage: [],
      visibleSources: [],
      redactionProfile: { expose: 'none', neutralize: true },
      auditLine: {
        role, ceiling: [],
        events: { considered: events.length, grounded: 0, excluded_by_visibility: events.length },
        documents: { considered: documents.length, grounded: 0, excluded_by_admissibility: documents.length, candidate_flagged: 0 },
        lineage: { considered: lineage.length, grounded: 0 },
        sources: { considered: sources.length, grounded: 0 },
        reason: 'client_contribution_only',
      },
    };
  }

  // D-5 · visibility ceiling (monotone by construction — visibilityForRole's sets are nested).
  const ceiling = visibilityForRole(role as WorkspaceRole);
  const allowed = new Set<string>(ceiling as readonly string[]);
  // An event with a missing visibility field is treated as 'internal_workspace' (operator-class only) —
  // conservative: it can never widen a viewer's bundle.
  const groundedEvents = events.filter((e) => allowed.has(typeof e.visibility === 'string' && e.visibility ? e.visibility : 'internal_workspace'));

  // D-6 · admissibility (strict §168 rule; see header).
  const groundedDocs: GroundedDocument<D>[] = [];
  let candidateFlagged = 0;
  for (const d of documents) {
    const decision = docDecision(d, String(view.user_id || ''));
    if (decision === 'approved') groundedDocs.push(d);
    else if (decision === 'candidate_own') { groundedDocs.push({ ...d, unpromoted: true }); candidateFlagged += 1; }
  }

  // §167/U2 · lineage is owner/operator-class (owner-only descriptions; not visibility-filtered upstream).
  const groundedLineage = OPERATOR_CLASS.has(role) ? [...lineage] : [];

  // T1/P3 · source-state facts are ops-internal (internal_workspace-class), same conservative classing as a
  // missing event visibility (above): owner/operator ground on them; a viewer does not. Monotone by class.
  const groundedSources = OPERATOR_CLASS.has(role) ? [...sources] : [];

  return {
    admissibleFacts: { events: groundedEvents, documents: groundedDocs },
    visibleLineage: groundedLineage,
    visibleSources: groundedSources,
    redactionProfile: { expose: 'full', neutralize: false },
    auditLine: {
      role, ceiling: ceiling as readonly string[],
      events: { considered: events.length, grounded: groundedEvents.length, excluded_by_visibility: events.length - groundedEvents.length },
      documents: { considered: documents.length, grounded: groundedDocs.length, excluded_by_admissibility: documents.length - groundedDocs.length, candidate_flagged: candidateFlagged },
      lineage: { considered: lineage.length, grounded: groundedLineage.length },
      sources: { considered: sources.length, grounded: groundedSources.length },
    },
  };
}

/** §168 acceptance helper — the client-egress neutralize INVARIANTS (D-7 keeps the client bundle empty, so
 *  these hold trivially today; they exist as the guard if a client spine is ever ratified). A bundle passes
 *  when no raw person-email, receipt uid, or route-shaped string appears anywhere in it. */
export function passesNeutralizeInvariants(bundle: unknown): boolean {
  const s = JSON.stringify(bundle) ?? '';
  if (/rcpt_[a-z0-9_]+/i.test(s)) return false;              // receipt uids never reach a client
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) return false; // raw emails never reach a client
  if (/\/api\/v1\//.test(s)) return false;                    // internal route shapes never reach a client
  return true;
}
