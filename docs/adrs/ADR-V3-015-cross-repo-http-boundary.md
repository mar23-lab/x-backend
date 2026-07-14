# ADR-V3-015 · Cross-repo HTTP surface · xcp-engine HTTP

**Status:** Accepted 2026-05-06 (audit Day 3 backfill)
**Date:** 2026-05-05 (originating decisions in commits `cfd7f3d` + `3f6cee2` · Sprint 4 M8)
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ADR-V3-002](ADR-V3-002-dal-adapters.md), [ADR-V3-013](ADR-V3-013-port-mirror-pattern.md), [ADR-V3-016](ADR-V3-016-http-surface-security-deferral.md), audit item 2.4

## Context

Sprint 4 M8 introduces the first cross-repo runtime boundary in the v3 stack. Until M8 the demo lived entirely in-process: WIs, evidence, skills all came from `data/initial-store.json` projected through `LiveEvidenceStorePort`. M8 wires `HttpEvidenceStorePort` against a stdlib HTTP surface on xcp-engine that reads `~/.xcp-demo/evidence.db` (Sprint 1 M2 SQLite schema).

This is significant because:
1. It is the FIRST live data path crossing the demo↔engine boundary.
2. It establishes the contract for future wires (skills bridge, attestation chain, real Marat session ingest).
3. The HTTP shape is now a public-ish API that pilot consumers will rely on.

Three architectural questions had to be resolved at once:
- Transport: stdlib http.server vs FastAPI vs aiohttp
- Endpoint shape: REST vs GraphQL vs JSON-RPC
- Tenancy model: how engine project_ids relate to demo project_ids

## Decision

### Transport: stdlib http.server

xcp-engine sticks to stdlib (no FastAPI). Reasons:
- Plan v3 §F: "engine stays Apache-2.0 open core" → minimise transitive deps that fragment the licence story
- Sprint 1 M2 already proved `sqlite3` (stdlib) is sufficient for evidence persistence
- FastAPI would pull pydantic + starlette + 6 transitive deps · all of which become source-of-truth for nothing
- Trade-off accepted: no auto-OpenAPI · no async middleware · no validation framework. Pilot may reverse this if/when FastAPI is needed.

### Endpoint shape: REST · 7 routes · read-only

```
GET  /api/v1/health
GET  /api/v1/bundles?workspace_id=&project_id=
GET  /api/v1/bundles/<bundle_id>/artefacts
GET  /api/v1/attestations/chain?correlation_id=
GET  /api/v1/attestations/<block_id>
GET  /api/v1/tenant/summary?workspace_id=&project_id=
GET  /api/v1/skills              [returns [] · skills bridge deferred]
```

Versioned at `/api/v1/` from day one. Future v2 ships alongside v1 with deprecation window.

Read-only by design (M8 first pass). Writes require ADR-V3-016 (security gate) before unlock.

### Tenancy model: workspace-scoped · project-decoupled

Demo's projectIds (`trinity`, `northstar`, `vertex`) are seed-only frontend identifiers. Engine's project_ids (e.g. `compliance-2026`, `TrinityOps`) are populated by xcp-runtime emit calls from MB-P closing skills using a different naming scheme.

In engine mode, the substrate widget passes only `workspace_id` to the port. `projectId` is dropped (otherwise the engine returns 0 bundles, since seed data uses different ids).

This is documented in `widgets/project-modes/Substrate/Substrate.jsx::PROJECT-ID MAPPING NOTE` (Audit-2.13 fix).

### CORS

Permissive default (`*`), configurable via `XCP_HTTP_CORS_ORIGIN`. **Pilot must lock this down** (see ADR-V3-016).

### Bundle title fallback

The current `list_bundles` aggregation derives title from `bundle_id` (no separate bundles table yet). When the bundles table arrives via a future schema migration, the title becomes a real column.

## Consequences

**Positive:**
- xcp-engine ships with zero new pip deps · stays Apache-2.0 + boring
- Substrate's `HttpEvidenceStorePort` works unchanged when the engine moves to FastAPI later (same routes, same shape)
- Versioned URL allows safe v2 evolution

**Negative:**
- No auto-validation: malformed query strings return 200 with degraded results, not 400. Pilot may need this.
- Stdlib http.server is single-threaded · concurrent reads serialise. SQLite WAL covers writes but read throughput is bottlenecked by the single Python event loop.
- No structured request log · audit trail must be added before pilot (ADR-V3-016).
- The "drop projectId in engine mode" workaround is a code smell. Real fix is either:
  (a) demo populates engine via xcp-runtime emit using its own ids (eliminates the drift), OR
  (b) engine's identity model exposes a project-id-translation layer
  Decision deferred to Sprint 5+.

**Out of scope:**
- WebSocket/SSE for real-time updates
- Skill invocation over HTTP (Sprint 5+ · separate ADR)
- Attestation chain mutation endpoints (Sprint 5+)

## Verification

- `curl http://localhost:8769/api/v1/health` returns `{ok: true, surface: "evidence-http-v1"}`
- `curl http://localhost:8769/api/v1/bundles?workspace_id=demo-ws` returns BundleSummary[]
- HttpEvidenceStorePort tests pass (11/11 vitest in xcp-platform)
- Demo at `?source=engine` renders bundles from real SQLite

## Open questions

- **Skills bridge timing** · Sprint 5 or 6? Blocks the SkillsBrowserWidget showing real registries.
- **HMAC scheme** · JWT vs API key vs session token? Deferred to ADR-V3-016 follow-up.
- **Real Marat session ingest** · MB-P closing-skill hook → `xcp-runtime emit` → SQLite. Spec needed.
