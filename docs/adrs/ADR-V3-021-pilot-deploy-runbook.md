# ADR-V3-021 · Pilot deploy runbook

**Status:** Accepted 2026-05-07 · Sprint 8
**Date:** 2026-05-07
**Decision-makers:** Marat
**Cross-link:** [ADR-V3-016](ADR-V3-016-http-surface-security-deferral.md), [ADR-V3-019](ADR-V3-019-http-hmac-replay-cors-log.md), [ADR-V3-020](ADR-V3-020-real-session-ingest.md), Plan v3.5 Sprint 8, `PILOT_IP_AUDIT_CHECKLIST_2026-05-07.md`

## Context

Sprints 1-7 made the demo + engine + ingest pipeline functional + secure (HMAC + replay + CORS + access log + sanitisation). Sprint 8 ships the operational artefacts so the engine survives a real machine: auto-start, body-size limits, expanded health probe, and an IP audit checklist.

ADR-V3-016's pre-pilot items 6-8 (LaunchAgent, body limit, health expansion) close here. Pilot gate items 1-5 already closed in Sprint 6.

## Decision

### 1. Body size limit · 1 MB default

Server config: `max_body_bytes` constructor arg + `XCP_MAX_BODY_BYTES` env + `--max-body BYTES` CLI flag. Default 1,048,576 (1 MB).

Behaviour:
- POST with `Content-Length` > limit → drain remaining body → respond `413 request body too large`
- Smaller POST → normal flow
- Drain-then-respond pattern prevents broken-pipe RST on the client

Why 1 MB: typical skill invocation is < 10 KB. 1 MB covers verbose RAG contexts. Operator can lower for stricter quota or raise for batch ingestion.

### 2. Expanded health probe

`GET /api/v1/health` response now includes:

```json
{
  "ok": true,
  "surface": "evidence-http-v1",
  "schema": "sqlite_evidence/v1",
  "schema_version": 1,
  "db_path": "~/.xcp-demo/evidence.db",
  "db_size_bytes": 86016,
  "last_write_at": "2026-05-07T01:25:56.716204Z",
  "hmac_enabled": true,
  "max_body_bytes": 1048576
}
```

Auditable from a single `curl` · no other endpoints needed for pilot diagnostics.

### 3. macOS LaunchAgent

`scripts/launchd/com.xcp.engine.plist` + `install.sh`. Runs xcp-engine HTTP at login · auto-restarts on crash (5s throttle).

Plist environment uses placeholders for secret · install.sh refuses to load if placeholder unchanged. Real secret should come from macOS keychain via a wrapper script (operator decision · keep secret out of plist file).

Logs: `~/.xcp-demo/engine-launchd.{out,err}.log` · operator-rotates manually for now (newsyslog config deferred).

### 4. IP audit checklist

`v3/docs/PILOT_IP_AUDIT_CHECKLIST_2026-05-07.md`. 9 sections (license boundaries · CLA · BUSL · SBOM · trademarks · confidentiality firewall · pilot contract · data handling · marketing claims). Mix of operator-decisions and counsel-review items. Final go/no-go gate before signing first pilot.

### 5. What's NOT in Sprint 8

- **Rate limit** · still deferred (single-actor scale). Sprint 6.5 candidate.
- **TLS termination** · operator's reverse proxy responsibility. Pilot deploy uses Caddy or nginx.
- **mTLS** · enterprise tier · post-pilot.
- **OAuth2/SAML** · post-pilot · multi-user identity.
- **Watchdog beyond launchd KeepAlive** · launchd is sufficient for single-host.
- **Body streaming** · 1 MB limit means full-body buffer is fine.

## Consequences

**Positive:**
- Engine survives reboot · auto-restart on crash · pilot doesn't need to know the start command
- Body limit closes a trivial DoS vector
- Expanded /health gives auditors a single endpoint to verify schema + last write
- IP audit checklist prevents legal-debt landmines from blocking pilot signing
- LaunchAgent install script refuses to load with placeholder secret (catches forgotten step)

**Negative:**
- LaunchAgent plist hardcodes Python path (`/opt/homebrew/...`) · breaks on Apple Silicon vs Intel paths · operator may need to edit
- Body limit is a single number across all routes · per-route limits deferred
- Health probe leaks internal counts (db_size, last_write_at) · acceptable for self-hosted pilot but reconsider if engine ever becomes multi-tenant SaaS
- IP audit checklist is operator-self-served until counsel review · risk of confirmation bias

**Out of scope:**
- xcp-cloud staging deploy (Plan v3 W6 · post-pilot)
- npm publish (Plan v3 W6 · post-community-adoption)
- xcp-control-plane rebuild (Plan v3 §C · post-2nd-tenant)

## Verification

Spec-first per ADR-V3-011 §1:

1. **Failing tests FIRST:** `services/http_surface/test_pilot_prep.py` (7 tests) · 5 fail on first run
2. **Implementation:** body-size limit + drain · health-probe expansion in `services/http_surface/server.py`
3. **All 7 tests PASS** + 30/30 Python total + 44/44 vitest
4. **Live verification:**
   - `curl http://localhost:8769/api/v1/health` → expanded JSON includes `schema_version`, `last_write_at`, `db_size_bytes`, `hmac_enabled`, `max_body_bytes`
   - `curl -X POST -d "$(python3 -c 'print("A"*2_000_000)')" /api/v1/skills/invoke` → 413
   - `sh scripts/launchd/install.sh` → installs plist · refuses without real secret
5. **IP audit checklist** drafted · operator + counsel run when first pilot signs

## Pilot-readiness summary (post-Sprint 8)

| Gate | ADR-V3-016 reference | Status |
|---|---|---|
| HMAC token validation | item 1 | ✅ Sprint 6 |
| Scoped CORS allowlist | item 2 | ✅ Sprint 6 |
| Structured access log | item 3 | ✅ Sprint 6 |
| Deny event emission | item 4 | ✅ Sprint 6 |
| Rate limit | item 5 | ⏸ Sprint 6.5 (deferred · single actor) |
| LaunchAgent + watchdog | item 6 | ✅ Sprint 8 |
| Health probe expansion | item 7 | ✅ Sprint 8 |
| Body size limit | item 8 | ✅ Sprint 8 |

**Status:** **PILOT-READY** for first prospect demo · pending operator IP audit pass.

## Open questions (Sprint 9+)

- Per-actor JWT alongside HMAC (multi-user identity)
- Streaming invocation responses (SSE)
- Newsyslog config for log rotation
- xcp-cloud staging deploy (when 2nd customer or hosted-pilot demanded)
- Rate limit (Sprint 6.5)
