# Tenant personalization policy — precedence, allow-list, promotion (T5/P4 · 260710)

**What this is:** the Codex-plan P4 policy surface — how per-user/per-company personalization works on
app.xlooop.com WITHOUT ever weakening governance. Every rule names the code that enforces it (or states
honestly that it is process-only).

## Precedence (highest wins; lower layers may only NARROW, never widen)
1. **MB-P hard rules** (governance SSOT; e.g. tenant isolation, forbidden surfaces)
2. **Tenant/company policy** (workspace-level; operator-curated)
3. **Project/domain policy** (scope bindings, admissibility promotions)
4. **Role/skill contract** (`docs/contracts/agent-roles.yml`, schema_id
   `xlooop.agent_role_runtime_manifest.v1`; runtime: `AGENT_ROLE_CONTRACT` in cockpit-chat)
5. **User preferences** (wording, defaults, shortcuts — the allow-list below)

## Personalization ALLOW-list (user-level, no review needed)
Wording/tone · examples · display defaults · terminology labels · workflow shortcuts · personal notes ·
personal skill preferences (e.g. preferred model tier where offered).

## NEVER-weaken list (no personalization rule may touch these; enforcing code named)
| Invariant | Enforced by |
|---|---|
| Tenant isolation | JWT-only workspace binding in every route; RLS second layer (043/053/059); `verify:auth-tenant-boundary`, `verify:postgres-rls-phase2` |
| Visibility ceiling / grounding ≤ ceiling | `visibilityForRole` + `assembleRoleScopedContext` (D-5, monotone) |
| Admissibility (approved-only grounding; proposer-only candidates) | `isAdmissibleForContext` + RSC docDecision (D-6) |
| Client contribution-only (no grounded spine) | RSC client rule (D-7) + `passesNeutralizeInvariants` |
| Redaction (receipts/audit: no model names, no non-member identities, no free-text reason) | D-8; `audit-export.ts` + `chat-receipt.ts` + `mcp-customer-reads.ts` |
| Retention / soft-delete recoverability | migration 044 + no-hard-delete gate |
| Approvals / sign-off authority | `authorizeSpineWrite`/`authorizeGovernedWrite` (one core) |
| Tool permissions / forbidden surfaces | `SAFE_TOOLS` + `FORBIDDEN_SURFACES` (mcp-gateway) |
| Evidence/receipt/lineage recording | spine companion emission (057) + receipts (058) + audit rows |

## Promotion workflow (user learning → company learning)
A user-level signal (`submit_learning_signal`) becomes COMPANY-level only through: explicit consent of the
proposing user → admin/operator review → source refs attached → sensitivity classification → an audit
receipt on promotion. Until promoted it personalizes ONLY its proposer (mirrors the D-6 candidate rule).
*Honest status:* the signal store + per-user profile exist (`get_effective_profile`); the promotion REVIEW
flow is process-only today (operator-mediated) — a dedicated review surface is future work, tracked in the
program report.

## Continuity honesty (what persists, exactly)
- **Durable:** SSOT rows — operation_events, evidence, receipts, documents, audit_logs, chat threads.
- **Advisory:** memory digests / effective profiles — regenerable projections, never authority.
- **Not guaranteed:** raw chat state that was never packetized into a thread/receipt.

## Customer UX boundary
Customers see product concepts only — workspace, sources, approvals, evidence, recommendations, audit
history. MB-P internals (graph schema, governance scoring, agent routing, skill registries) are FORBIDDEN
surfaces (`FORBIDDEN_SURFACES`) and never appear in customer-facing copy, payloads, or MCP tools.
