# ADR-V3-016 · HTTP surface security · deferral + pilot gate

**Status:** Accepted 2026-05-06 (audit Day 3 backfill · audit item 2.9)
**Date:** 2026-05-05
**Decision-makers:** Marat
**Supersedes:** none
**Cross-link:** [ADR-V3-015](ADR-V3-015-cross-repo-http-boundary.md), Plan v3 §V Confidentiality Boundary

## Context

ADR-V3-015's HTTP surface ships with intentional security gaps:
- No authentication (no JWT, no HMAC, no API key)
- CORS defaults to `*`
- No rate limit
- No request log / audit trail
- Skills `invokeSkill` returns deny-stub but the deny is not logged

This is acceptable for local dev (the surface only serves the operator's own machine on `localhost:8769`). It is **not** acceptable for pilot deploy. Plan v3 §V Confidentiality Boundary requires per-skill policy gate with HMAC-SHA-256 attestation chain · the current surface ships none of that.

The audit (`AUDIT_PHASE_C4_M8_2026-05-05.md` item 2.9) flagged this as pilot-blocking. This ADR records the gap explicitly so it cannot be forgotten.

## Decision

The HTTP surface ships M8 read-only with the gaps above. Before the FIRST pilot deployment, the following items must land:

### Pilot gate · MUST land before any pilot demo deploy

1. **HMAC-SHA-256 token validation** on all endpoints
   - Token issued by xcp-engine on session start, includes workspace_id + actor_id + expiry
   - Demo's HttpEvidenceStorePort gains a `token` constructor option, sends `X-XCP-Token` header
   - Server verifies HMAC against shared secret (env `XCP_HMAC_SECRET`)
2. **Scoped CORS** · explicit allowlist via `XCP_HTTP_CORS_ORIGIN` (no `*`)
3. **Structured access log** · JSONL · one line per request with method, path, status, actor_id, latency_ms, tenant
4. **Deny event emission** · when invokeSkill returns deny, emit attestation block with `verify_status='denied'` so the audit trail captures it
5. **Rate limit** · simple token bucket per actor_id (default: 60 req/min · configurable)

### Pre-pilot prep · should land before pilot prospect demo

6. **Watchdog / lifecycle** · LaunchAgent plist + auto-restart + log rotation (audit item 2.15)
7. **Health probe expansion** · `/health` returns schema version, last-write timestamp, db file size
8. **Request body size limit** · 1 MB default for POST/PUT (when writes unlock)

### Out of scope for pilot

- TLS · pilot deploys via reverse proxy (nginx / Caddy) which terminates TLS
- mTLS · enterprise tier only
- OAuth2 · no third-party identity provider in scope yet

## Consequences

**Positive:**
- Gap is explicit · cannot be forgotten when pilot prospect arrives
- Clear "before-pilot" checklist gives the operator a definite stop condition
- Token shape pins the HMAC pattern early, reducing later refactor

**Negative:**
- Adds ~3-5 days of work between "demo ready" and "pilot ready"
- HMAC-secret-management story is undefined · operator must pick (env var vs file vs keychain)
- No pilot can be promised before this lands · Plan v3 §V is the load-bearing claim

**Out of scope:**
- Production-grade IAM (Cognito/Auth0/etc.) · enterprise tier only

## Verification

Pilot readiness checklist (must all be ✅ before any pilot deploy):

- [ ] HMAC token validation on all 7 endpoints · request without token returns 401
- [ ] CORS allowlist enforced · request from disallowed origin returns 403 OPTIONS
- [ ] Rate limit enforced · 61st request in 60s returns 429
- [ ] Access log JSONL writes to `~/.xcp-demo/access.log` · one line per request
- [ ] Deny event written to attestations table on every `invokeSkill` deny
- [ ] LaunchAgent plist present at `~/Library/LaunchAgents/com.xcp.engine.plist`
- [ ] `XCP_HMAC_SECRET` set via 1Password CLI / keychain (not committed to git)

## Stop conditions

If any of the following happen, halt pilot prep and re-open this ADR:

- HMAC scheme has not been chosen by 2026-06-01
- Pilot prospect requests TLS in the demo loop · upgrade ADR scope
- Audit log volume exceeds 1 GB/day in dev (rotation + sampling needed)

## Effort estimate

3-5 working days for pilot gate · 1 day for pre-pilot prep · 0 days for out-of-scope items.

Status as of 2026-05-05: **none of the pilot-gate items have started.** Pilot is blocked until they do.
