# ADR-V3-030: Server-side customer action resolution

**Status:** Proposed (NOT ratified — do not implement)
**Date:** 2026-07-14
**Deciders:** Marat (product/domain), engineering seat

## Context

Wave 260714-F shipped a CLIENT-side continuation resolver in the wired adapter
(x-ai-front wired/live-data.js · resolveDoIntent): question-shaped Do-mode input routes to the
existing grounded ask path; decision/continuation verbs resolve against the hydrated pending/blocked
queue and navigate via openInQueue; resolution never mutates; a decision verb never auto-approves.
This covers all CURRENT journeys because every needed fact (pending sign-offs, blocked items, packet
id map, mode, authority envelope) is already hydrated client-side.

The "Natural Operability" critique (260714) proposed a SERVER-side `CustomerActionResolution`
(kind/confidence/target/nextAction/explanation) attached to the customer-chat response.

## Decision (proposed)

Defer the server-side resolver until one of these triggers holds:
1. Multi-surface clients (mobile/MCP/another UI) need the SAME resolution semantics — duplication of
   the client resolver would begin.
2. Queue scale exceeds the hydrated slice (resolution over items the client has not loaded).
3. Resolution needs server-only signals (cross-workspace state, policy engine outcomes).

When triggered: extend the EXISTING /customer-chat response with a customer-safe `action_resolution`
field (never a new parallel command endpoint); resolution stays read-only; execution stays on the
canonical packet/sign-off/source routes; internal operation ids and policies stay server-side;
low confidence returns `clarify`.

## Options considered

**A · Client resolver only (CHOSEN for now):** zero new contract surface, provable in verify:wired,
all data already hydrated. Con: per-client duplication if surfaces multiply.
**B · Server resolution now:** single source of resolution semantics. Con: new contract + serializer +
tests for capability the single current client already has; violates smallest-viable-change.
**C · LLM-side classification:** flexible language. Con: unprovable in gates; unacceptable
nondeterminism next to governed writes.

## Consequences
- The interaction contract lives today in the adapter + its 15 operability proofs
  (x-ai-front wired/scripts/test-writes.mjs) and NATURAL_OPERABILITY_PRODUCTION_BASELINE.md.
- Revisit at the first trigger above; ratification (status → Accepted) is an operator decision.
