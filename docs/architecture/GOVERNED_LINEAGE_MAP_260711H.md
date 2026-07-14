# Governed lineage map — intent → packet → event → tool → decide → evidence (260711-H, R3)

Every customer action on app.xlooop.com flows through a single governed causal chain. Each hop has a
real backend route, a blocking gate that protects its invariant, and (where activation is staged) a
flag. This is the "traceable and auditable across the customer ecosystem" spine made concrete: any
agent can follow a customer's intent from the chat turn to the immutable event that recorded it.
This doc is a backend reference — it travels with x-backend at the seed.

| Hop | What it is | Real route (file) | Governing gate | Flag (staged activation) |
|---|---|---|---|---|
| **intent** | a customer chat turn (the ask) | `POST /api/v1/customer-chat` (`routes/customer-chat.ts`) · operator: `POST /api/v1/cockpit-chat` (`routes/workspaces.ts`) | verify:ip-boundary-suite (customer-chat-route) · seed-contract-parity (payload shape) | CHAT_ROLE_SCOPED_CONTEXT_ENABLED (grounding) |
| **grounding** | role-scoped context for the LLM (graph → roles/skills/sources → fact bundle) | in-process `services/role-scoped-context.ts` (NOT an endpoint) → durable trace in `chat_messages.grounded_on.assembly` | verify:context-reaches-consumer · L1 assembly-trace (fails closed past depth budget) | CHAT_ASSEMBLY_TRACE_ENABLED · SOURCE_TIER_GROUNDING_ENABLED · GRAPH_DOCUMENT_NODES_ENABLED |
| **packet** | a task_packet opened from the intent | `POST /api/v1/packets` (`routes/operational-spine.ts`), `authorizeSpineWrite('packet:create')` | verify:ip-boundary-suite (operational-spine-route) · allowed-actions-server-derived | ENTITLEMENT_ENFORCEMENT (authority) · IDEMPOTENCY_ENABLED (mig 065) |
| **tool-event** | an MCP tool run reported against the packet | `POST /api/v1/mcp/tool-events` (`routes/mcp-gateway.ts`) → companion `operation_events` INSERT | verify:op-events-append-only · verify:no-raw-operation-events-insert | SPINE_TOOL_EVENT_UNIFICATION_ENABLED (mig 057) · MCP_READ_AUDIT_ENABLED (mig 063) |
| **event** | the immutable causal fact (append-only) | `GET /api/v1/events` (`routes/events.ts`, role-redacted) · writes via the spine | verify:op-events-append-only · verify:causation-traceability · verify:project-events-visibility-floor | — (append-only always on) |
| **decide** | an operator verdict (deny-wins) | `POST /api/v1/sign-offs` (`routes/sign-offs.ts`, `authorizeGovernedWrite('signoff:decide')`) · `PATCH /api/v1/approvals/:id` | verify:ip-boundary-suite (spine-authority: projection===enforcement) · principal-redaction | ENTITLEMENT_ENFORCEMENT (deny-wins post-flip) |
| **evidence** | promoted evidence / attached document (SHA-256 lineage) | `POST /api/v1/evidence` · `POST /api/v1/mcp/evidence` · `POST /api/v1/documents` (`routes/documents.ts`, content_hash sha256, mig 051) · promote `PATCH /documents/:id/admissibility` | verify:document-version-chain · verify:principal-instrument-lineage · verify:audit-coverage | DOCUMENT_READ_AUDIT_ENABLED (mig 059) |
| **receipt** | a minted receipt id per governed answer | `chat_messages.receipt_uid` (mig 058) | verify:session-event-audit | CHAT_RECEIPT_GROUNDING_ENABLED (mig 058) |
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
All flags default-off (byte-identical prod). The operator flip sequence + migration applies
(042/062/063/064/065) are in `docs/deployment/ACTIVATION_SHEET_260711.md`. Post-flip, the whole chain
is enforced end-to-end and every hop writes an auditable row — the "applied across all app.xlooop.com
customers" guarantee. The 4 F14-ratified controls (assign-task, entity-owner, rt-validate, event.comment)
extend the **packet**/**decide** hops and land as x-backend's post-seed shakedown wave.
