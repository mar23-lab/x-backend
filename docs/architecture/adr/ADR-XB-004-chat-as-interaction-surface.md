# ADR-XB-004 — Chat Is an Interaction Surface, Never a Truth Container

- **Status:** accepted (ratified by operator authorization, 2026-07-20 — Marat Basyrov, session 260720; execution rides the N-UX waves)
- **Date:** 2026-07-20
- **Owner:** marat
- **Relates:** CANONICAL_DOMAIN_MODEL.md §3/§4; mig 071 (context_receipts, staged); ADR-XB-007 R1

## Context

Chat is the primary composer surface, and its context assembly is ad hoc today: what a
run "knows" is whatever the handler gathered, unrecorded. The precedence order is
unimplemented, mig 071 (`context_packets` — counts-only, FNV fingerprint, HS256
signature, skill_coverage) is authored but staged, and nothing stops chat threads from
drifting into de-facto truth stores ("the decision is in the chat"). Both assessments
ratified the same rule: chats reference scopes; they never own truth.

## Decision

1. **Chat REFERENCES scopes** (workspace/domain/project/lens); it never owns objectives,
   work items, decisions, or evidence. Anything durable born in chat must land in its
   canonical home (intent, packet, decision, proposal) via the existing flows.
2. **Context is assembled by the precedence order** of CANONICAL_DOMAIN_MODEL §4
   (platform → tenant → workspace charter → portfolio objectives → domain knowledge →
   project scope → bound resources filtered BEFORE retrieval → intent → user prefs →
   session-local), and the assembled bundle is recorded as a **context_receipt**
   (mig 071, renamed per ADR-XB-007 R1) with hash — "what did the agent know" becomes
   auditable per run.
3. The composer surfaces a **context-preview chip** (what the run will know) once 071
   activates (N-UX.2, operator-gated flag).
4. Session-local conversation state is the lowest precedence layer and is never
   persisted as truth.

## Options considered

- **A. Chat-owned memory as the context source** — rejected: unauditable, unscoped,
  and the direct path to chat-as-truth-container; contradicts the single-intake spine.
- **B. Precedence assembly without receipts** — rejected: implements the behavior but
  keeps "what did the agent know" unanswerable — the operator's context question stays open.
- **C. Precedence assembly + context_receipt per run (chosen)** — the receipt is already
  authored (071); this is activation + rename, not new architecture.

## Consequences

- Every agent/chat run gains an auditable context lineage record.
- Chat UX changes are additive (preview chip); no thread data migrates.
- Until 071 activates, the rule is enforceable in review (no new truth-in-chat
  features) even though receipts are not yet emitted.
