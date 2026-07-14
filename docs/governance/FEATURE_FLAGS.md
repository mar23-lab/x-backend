# Backend feature-flag inventory (canonical) — 260711-J FGH-3

The single reference for every `*_ENABLED` env flag the Cloudflare Worker reads. Closes audit
finding FGH-3 (no canonical inventory: 15 code-read flags were undocumented outside scattered
comments).

**Parse-safety is ENFORCED, not documented:** every flag is read through
`src/workers/lib/env-flag.ts::envFlagTrue` (quote/whitespace/case tolerant). The gate
`scripts/verify-flag-parse-hygiene.mjs` (ci-local, blocking) fails any `*_ENABLED` compared with a
bare `=== 'true'` / `!== 'true'` / `.toLowerCase() === 'true'`. `envFlagTrue` itself is covered by
`src/workers/__tests__/session-env-flag.test.ts`.

**Refresh** (this table can drift; the gate + wrangler.toml are the SSOT):
`grep -rhoE "[A-Z][A-Z0-9_]*_ENABLED" src/workers --include="*.ts" | sort -u` (code reads) ·
`grep -nE "_ENABLED" wrangler.toml` (deployed [vars]).

## Direction legend
- **fail-safe-off** — OFF is the safe/legacy state; ON adds a capability. Byte-identical when off.
- **fail-toward-less-safe** — OFF removes a guard (a security control): the ON path is the safer
  one. These MUST use envFlagTrue (a quoted `"true"` that silently didn't engage = a live gap).

## Deployed ON (declared `= "true"` in wrangler.toml [vars] → value `true`)
| Flag | Direction | Purpose |
|---|---|---|
| `RECLASSIFY_CRON_ENABLED` | fail-safe-off | hourly reclassify-unattributed self-heal cron |
| `DIGEST_SWEEP_ENABLED` | fail-safe-off | weight-retune / digest sweep cron |
| `CLERK_INVITATIONS_ENABLED` | fail-safe-off | investor magic-link invite on tier grant |
| `ENRICHMENT_SWEEP_ENABLED` | fail-safe-off | enrichment sweep cron |
| `CUSTOMER_SELF_SERVICE_ENABLED` | fail-safe-off | customer self-service surface |
| `CHAT_SOURCE_TRUTH_OVERRIDE_ENABLED` | fail-safe-off | source-truth override in chat grounding |
| `CHAT_ROLE_SCOPED_CONTEXT_ENABLED` | fail-safe-off | role-scoped chat context (G9) |
| `SPINE_TOOL_EVENT_UNIFICATION_ENABLED` | fail-safe-off | emit unified spine event on tool-events |
| `DOCUMENT_READ_AUDIT_ENABLED` | fail-safe-off | document-read audit rows (mig 059) |
| `CHAT_GRAPH_CONTEXT_ENABLED` | fail-safe-off | graph-context injection into chat |

## Unbound → OFF (activation = redeploy with the var, dashboard var, or `wrangler secret put`)
| Flag | Direction | Purpose |
|---|---|---|
| `SOURCE_SCOPE_ENFORCEMENT_ENABLED` | **fail-toward-less-safe** | restricted-scope guard on source rows (sources.ts); OFF = a source may claim a capability its token can't exercise. FGH-1: dashboard-only activation → MUST be quote-tolerant (now is). |
| `IDEMPOTENCY_ENABLED` | fail-safe-off | Idempotency-Key reserve-first on governed writes (mig 065 staged) |
| `CUSTOMER_API_TOKENS_ENABLED` | fail-safe-off | customer bearer-token auth path |
| `CUSTOMER_OPERATIONAL_TOKENS_ENABLED` | fail-safe-off | operator-scoped customer tokens |
| `MEMBER_REMOVAL_ENABLED` | fail-safe-off | member-remove soft-delete + entitlement revoke (mig 062 staged) |
| `SOURCE_TIER_GROUNDING_ENABLED` | fail-safe-off | D-16 source-tier grounding weight in chat |
| `GRAPH_DOCUMENT_NODES_ENABLED` | fail-safe-off | document nodes in the data graph |
| `CHAT_ASSEMBLY_TRACE_ENABLED` | fail-safe-off | durable chat context-assembly trace (L1) |
| `CHAT_RECEIPT_GROUNDING_ENABLED` | fail-safe-off | receipt links in chat grounding |
| `MCP_READ_AUDIT_ENABLED` | fail-safe-off | MCP tenant-read audit (mig 063 staged) |
| `LLM_USAGE_METERING_ENABLED` | fail-safe-off | LLM usage metering (mig 064 staged) |
| `MBP_PROJECTION_LIVE_RAIL_ENABLED` | fail-safe-off | MB-P projection over the live rail (H1) |
| `CONTEXT_RESOLVER_ENABLED` | fail-safe-off | onboarding context resolver |
| `PURGE_DELETED_ENABLED` | fail-safe-off | purge-deleted cron (hard-delete of soft-deleted rows) |
| `SAFETY_FLOOR_RATELIMIT_ENABLED` | fail-safe-off | rate-limit on LLM-cost endpoints (SF-2) |
| `CUSTOMER_SAFE_SERIALIZER_ENABLED` | fail-safe-off | AR-0.2 · customer-safe projection: strips internal provisioning ids from /session entitlement + engine name / model / grounded_on ids from /customer-chat. OFF = byte-identical (fields still emitted); ON = redacted. Wired at session.ts + customer-chat.ts, enforced by `verify:no-internal-ip-customer-payload`. |
| `ROLE_SKILL_CATALOG_ENABLED` | fail-safe-off | AR-2.1 · the KEYSTONE. When the shadow role/skill resolver is on (`ROLE_SKILL_RESOLVER_ENABLED`), this makes `resolveBindings` read the W3-published catalog (real skill bindings) instead of the empty floor. OFF (default) = floor = byte-identical shadow (skill_coverage='no_catalog'); ON = real resolution (coverage moves off zero). Loader = role-skill-catalog-loader.ts; drift-gated by `verify:role-skill-catalog-loader-fresh`. |

All 28 flags are read via `envFlagTrue`. The 10 declared-ON are byte-identical under the
J-W0 refactor (`true` reads true under both strict and tolerant parse); the refactor only changes
the quoted-`"true"` activation case, which is exactly the FGH-1 fix for the un-declared flags above.
