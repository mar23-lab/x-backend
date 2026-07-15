---
status: pre_cutover_default_off
owner: x-backend
last_verified: 2026-07-15
verifiers:
  - npm run verify:model-execution-callsites
  - npm run verify:context-reaches-consumer
consumers:
  - backend engineers
  - pre-cutover readiness review
---

# Governed lineage map — intent → context → execution → evidence (260711-H, R4)

This is the target causal chain for governed customer actions. It is structurally implemented, but
strict persistence remains default-off and no cutover or authority switch is authorized. Each row
therefore distinguishes an available backend surface from an activated production guarantee. The
machine-enumerable model call sites live in `docs/contracts/model-execution-callsite-manifest.json`.

| Hop | What it is | Real route (file) | Governing gate | Flag (staged activation) |
|---|---|---|---|---|
| **intent** | a customer chat turn (the ask) | `POST /api/v1/customer-chat` (`routes/customer-chat.ts`) · operator: `POST /api/v1/cockpit-chat` (`routes/workspaces.ts`) | verify:ip-boundary-suite (customer-chat-route) · seed-contract-parity (payload shape) | CHAT_ROLE_SCOPED_CONTEXT_ENABLED (grounding) |
| **grounding** | role-scoped context for the LLM (graph → roles/skills/sources → fact bundle) | in-process `services/role-scoped-context.ts` (NOT an endpoint) → durable trace in `chat_messages.grounded_on.assembly` | verify:context-reaches-consumer · L1 assembly-trace (fails closed past depth budget) | CHAT_ASSEMBLY_TRACE_ENABLED · SOURCE_TIER_GROUNDING_ENABLED · GRAPH_DOCUMENT_NODES_ENABLED |
| **context receipt** | a signed, customer-safe record of role, skill, scope counts, redaction and context fingerprint | `lib/assistant-context-lineage.ts` → `role_skill_resolutions` + `context_packets` | `verify:model-execution-callsites` · role-skill catalog freshness/parity | CONTEXT_PACKET_PERSISTENCE_ENABLED |
| **model execution** | one started/terminal receipt per provider attempt, linked to the context packet and role/skill resolution | `model_execution_receipts` (migration 078, staged only) | `verify:model-execution-callsites` reports 9/9 call sites | CONTEXT_PACKET_PERSISTENCE_ENABLED |
| **packet** | a task_packet opened from the intent | `POST /api/v1/packets` (`routes/operational-spine.ts`), `authorizeSpineWrite('packet:create')` | verify:ip-boundary-suite (operational-spine-route) · allowed-actions-server-derived | ENTITLEMENT_ENFORCEMENT (authority) · IDEMPOTENCY_ENABLED (mig 065) |
| **tool-event** | an MCP tool run reported against the packet | `POST /api/v1/mcp/tool-events` (`routes/mcp-gateway.ts`) → companion `operation_events` INSERT | verify:op-events-append-only · verify:no-raw-operation-events-insert | SPINE_TOOL_EVENT_UNIFICATION_ENABLED (mig 057) · MCP_READ_AUDIT_ENABLED (mig 063) |
| **event** | the immutable causal fact (append-only) | `GET /api/v1/events` (`routes/events.ts`, role-redacted) · writes via the spine | verify:op-events-append-only · verify:causation-traceability · verify:project-events-visibility-floor | — (append-only always on) |
| **decide** | an operator verdict (deny-wins) | `POST /api/v1/sign-offs` (`routes/sign-offs.ts`, `authorizeGovernedWrite('signoff:decide')`) · `PATCH /api/v1/approvals/:id` | verify:ip-boundary-suite (spine-authority: projection===enforcement) · principal-redaction | ENTITLEMENT_ENFORCEMENT (deny-wins post-flip) |
| **evidence** | promoted evidence / attached document (SHA-256 lineage) | `POST /api/v1/evidence` · `POST /api/v1/mcp/evidence` · `POST /api/v1/documents` (`routes/documents.ts`, content_hash sha256, mig 051) · promote `PATCH /documents/:id/admissibility` | verify:document-version-chain · verify:principal-instrument-lineage · verify:audit-coverage | DOCUMENT_READ_AUDIT_ENABLED (mig 059) |
| **receipt** | a minted receipt id per governed answer | `chat_messages.receipt_uid` (mig 058) | verify:session-event-audit | CHAT_RECEIPT_GROUNDING_ENABLED (mig 058) |
| **current-work receipt count** | tenant-scoped count of completed/fallback model execution receipts; unavailable is not represented as zero | `GET /api/v1/current-work` | current-work route/store tests | CONTEXT_PACKET_PERSISTENCE_ENABLED |
| **meter** | per-tenant LLM spend (day-grain) | `GET /api/v1/llm-usage` (owner/operator) · capture in cockpit-chat | verify:governance-pillars (llm_usage invariant) | LLM_USAGE_METERING_ENABLED (mig 064) |

## Cross-cutting invariants (every hop honors)
- **Tenant isolation**: RLS 2nd layer (`xlooop_rls_workspace_id()`, migrations 043/053) + route-level
  workspace re-assertion. Gates: verify:postgres-rls-phase2 · verify:rls-runtime-enforcement ·
  verify:tenant-source-isolation.
- **Authority**: ONE decision core `canActOnSpine` (`lib/permissions.ts`, deny-wins) drives BOTH write
  enforcement (`authorizeSpineWrite`) AND the read projection (`/session.identity.spine_authority`); the
  frontend gates controls on that envelope + the 18-action `data/spine-authority-vocabulary.v1.json`
  (verify:spine-vocabulary). Never a hardcoded FE action table.
- **Redaction**: `redactPrincipalForRole` fails CLOSED on unknown role (verify:principal-redaction).
- **Idempotency**: uniform `Idempotency-Key` header + reserve-first dedupe (mig 065) on every governed
  write group — no write slice reaches cutover-`wired` without it (§220-B).
- **Honest freshness**: `routes/mbp-projection.ts` carries served_at/served_from/freshness; never a
  fake-fresh stamp masking staleness.

## Activation state
All new strict-lineage and projection controls are default-off. Migrations 076–078 are staged and
must not be applied by this plan. Structural tests prove pre-cutover behavior; they do not prove live
RLS, production credentials, production data, or a customer-wide guarantee. A later activation must
have an explicit Marat-approved artifact, live RLS proof, authenticated journey evidence, rollback
rehearsal and a fresh authority packet. Until then, deterministic/default behavior remains authority.
