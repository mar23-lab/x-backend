# ADR-V3-018 · Skills bridge over HTTP

**Status:** Accepted 2026-05-07 · Sprint 5
**Date:** 2026-05-07
**Decision-makers:** Marat
**Cross-link:** [ADR-V3-015](ADR-V3-015-cross-repo-http-boundary.md), [ADR-V3-016](ADR-V3-016-http-surface-security-deferral.md), Plan v3 §V Confidentiality Boundary, ADR-V3-011 (TDD discipline · spec-first)

## Context

Sprint 4 M8 wired the demo to xcp-engine for read-only evidence. The skills surface (`/api/v1/skills`) returned `[]` and `invokeSkill` returned a deny stub. Sprint 5 closes that gap: the SkillsBrowserWidget now reads a real registry and invokes real skills with attestation chain emission.

This is the **first write path** crossing the demo↔engine boundary. ADR-V3-015 deferred writes pending security gate (ADR-V3-016). Sprint 5 ships the write path **for skill invocation only** because:
- Invocations have a minimal attack surface (input is a prompt + visibility tag)
- Plan §V's policy gate is already enforced server-side (LLMBridge.dispatch)
- All invocations produce signed attestation blocks · trail is auditable
- No customer data is exposed; demo data is contrived seed only

The pilot security gate (ADR-V3-016) still applies for any deployment beyond local dev.

## Decision

### Wire shape

**`GET /api/v1/skills`** returns `SkillDescriptor[]` from a static catalog (3 demo skills) merged with `recent_invocation_count` derived from the SQLite `attestation_blocks` table:

```json
[
  {
    "skill_id": "summarise-evidence",
    "description": "...",
    "max_output_visibility": "client-visible",
    "enabled": true,
    "recent_invocation_count": 2
  },
  ...
]
```

**`POST /api/v1/skills/invoke`** accepts `SkillInvocationRequest` (mirrors substrate's TS type) and returns `SkillInvocationResult`:

```json
// Request
{
  "skill_id": "summarise-evidence",
  "input_text": "...",
  "input_visibility": "agency-visible",
  "requested_output_visibility": "agency-visible",
  "actor_id": "demo.user",
  "correlation_id": "corr-uuid",
  "workspace_id": "demo-ws",        // optional · scopes attestation row
  "project_id": "TrinityOps",       // optional
  "model_preference": "ollama/...", // optional · falls back to env default
  "prior_attestation_id": "att.x"   // optional · explicit chain link
}

// Response (completed)
{
  "request_id": "req.abc123",
  "status": "completed",
  "skill_id": "summarise-evidence",
  "correlation_id": "corr-uuid",
  "output_text": "...",
  "output_visibility": "agency-visible",
  "attestation_block_id": "att.def456",
  "model_identity": "ollama/llama3.2:1b"
}
```

`status` ∈ `'completed' | 'denied' | 'error'`. Denials carry `deny_reason`. Errors carry `error`.

### Server-side orchestration

Server route `route_POST_skills_invoke`:

1. Validate body (required fields → 400 on missing)
2. Verify `skill_id` is in catalog → otherwise return `denied` with `deny_reason: 'unknown skill_id'`
3. Build `BridgeRequest` from body
4. `LLMBridge.dispatch(req)` → orchestrates policy gate → llm_bridge dispatch → attestation block sign
5. Persist `AttestationBlock` to `evidence_artefacts.attestation_blocks` table (skipped silently if persist fails to avoid breaking the response)
6. Map `BridgeResponse` → `SkillInvocationResult` JSON

### Client-side (substrate)

`HttpEvidenceStorePort.invokeSkill` POSTs to `/api/v1/skills/invoke`. On HTTP error (404/500/etc.) returns `status: 'error'` with the underlying message. On JSON parse failure returns `status: 'error'`.

### Skills catalog source of truth

`packages/xcp-engine/services/http_surface/skills_registry.py` defines the static catalog. Future evolution:
- Sprint 6+: skills emit themselves via `xcp-runtime emit` (MB-P closing-skill hook). Catalog moves from static to derived.
- Pilot: customer-facing UI to enable/disable skills per workspace · joins to a `skill_assignments` SQLite table.

### Default model

`ollama/llama3.2:1b` per Sprint 1 M1 ADR. `XCP_LLM_BRIDGE_STUB=1` is the default (returns deterministic stub responses) — operators set `XCP_LLM_BRIDGE_STUB=0` to use real Ollama. Demo deploys ship in stub mode.

## Consequences

**Positive:**
- First end-to-end loop: substrate widget → demo → engine → SQLite → attestation chain → demo UI render
- Real attestation chain proven · the §V claim ("HMAC-SHA-256 attestation") has runtime evidence
- Skills catalog is extensible without code change (just add an entry to skills_registry.py)
- Spec-first discipline honoured: 4 failing TS tests + 6 Python tests written **before** implementation. ADR-V3-011 §1 satisfied for the first time.

**Negative:**
- Endpoint accepts body without HMAC token · ADR-V3-016 pilot gate still required before any pilot deploy
- No request log of denials yet · audit trail incomplete (denied invocations don't produce attestation blocks)
- Skills catalog is static · doesn't reflect real Marat-as-system skill inventory until Sprint 6 hook lands
- `model_preference` opens dispatch path to BYOK if substrate's caller lies about visibility · server-side policy gate is the only check

**Out of scope:**
- Real-time invocation status streaming (SSE/WebSocket) · pull-based for now
- Concurrent invocation queue management · stdlib http.server is single-threaded; serial invocations are fine for demo, will need worker pool for pilot
- Invocation history pagination · `listInvocations` returns `[]` until that lands

## Verification

Per ADR-V3-011 spec-first:

1. **Failing spec FIRST (commit-pair anchor):**
   - `xcp-platform/apps/intent-ai-app-template/src/services/evidence-store-port/HttpEvidenceStorePort.skills.test.ts`
   - 4 tests · all FAILED on first run with the M8 deny-stub implementation
   - Failure output captured in commit message

2. **Implementation:**
   - `HttpEvidenceStorePort.invokeSkill` rewritten · 4 tests now pass
   - Engine: `services/http_surface/server.py` adds `route_POST_skills_invoke` + `route_skills_list` rewrite
   - Engine: `services/http_surface/skills_registry.py` (new · 3 demo skills)
   - Engine: `services/http_surface/test_skills_bridge.py` (new · 6 Python tests · all pass)

3. **Smoke checks:**
   - `audit-2.3` extended: SkillInvocationRequest + SkillInvocationResult contract test in demo
   - smoke-cli: 271/271 + new Sprint-5 checks

4. **Live verification:**
   - `?source=engine` → SkillsBrowserWidget renders 3 skills with real recent_invocation_count
   - Invoking `summarise-evidence` from the widget produces a real attestation block in `~/.xcp-demo/evidence.db`
   - GET `/api/v1/skills` afterwards shows incremented count

## Open questions (carry-over to Sprint 6)

- HMAC token + scoped CORS (per ADR-V3-016 pilot gate)
- Streaming invocation responses (LLM token-by-token)
- Invocation history endpoint (`GET /api/v1/skills/invocations?skill_id=&limit=`)
- Real Marat session ingest (`POST /api/v1/evidence/artefacts` from MB-P closing skills)
