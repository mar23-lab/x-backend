# ADR-V3-022 · Rate limit · token-bucket per actor_id

**Status:** Accepted 2026-05-07 · Sprint 9 (Sprint 6.5 deferral closed)
**Date:** 2026-05-07
**Decision-makers:** Marat
**Cross-link:** [ADR-V3-016](ADR-V3-016-http-surface-security-deferral.md), [ADR-V3-019](ADR-V3-019-http-hmac-replay-cors-log.md), [ADR-V3-021](ADR-V3-021-pilot-deploy-runbook.md)

## Context

ADR-V3-016 listed rate limit as pilot-gate item 5. Sprint 6 deferred it to "Sprint 6.5" because the threat model was single-actor (just Marat). Sprint 9 closes the deferral now that the engine is pilot-ready · the missing item from the gate matrix.

Rate limit is not blocking pilot · but ADR-V3-016 promised to revisit, and shipping it now removes a known TODO before the first prospect demo (cleanest hygiene).

## Decision

### Token-bucket per actor_id

**Bucket key resolution:**
1. POST: parse `actor_id` from request body → key `actor:<actor_id>`
2. GET or POST without actor_id: fall back to `client_address[0]` (remote IP)

**Bucket dynamics:**
- Bucket size = `rate_limit_per_min` (operator config · default disabled)
- Refill rate = `bucket_size / 60` tokens/sec (continuous)
- Each request consumes 1 token
- Empty bucket → 429 with `Retry-After` header (RFC 6585)
- Buckets are in-memory · reset on server restart by design

### Response shape

429 response carries:
```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: <seconds>

{"error":"rate limit exceeded · 60 req/min budget · retry in 5s"}
```

### Configuration

| Source | Default | Pilot recommended |
|---|---|---|
| Constructor `rate_limit_per_min` | None (disabled) | 60 |
| Env `XCP_RATE_LIMIT_PER_MIN` | unset | `60` |
| CLI `--rate-limit N` | unset | `--rate-limit 60` |

Disabled-by-default keeps dev frictionless; pilot deploys opt in via env.

### Out of scope

- **Distributed rate limit** (across multiple engine processes) · single-host pilot scope · stays in-memory
- **Persistent bucket state across restart** · buckets reset is desirable (graceful budget reset on operator restart · prevents starvation if a stuck bucket somehow corrupted)
- **Different limits per skill or per workspace** · one limit per actor_id for now · Sprint 10+ if pilot demands tiering
- **Burst credit (token-bucket pre-filling above size)** · standard token bucket caps at size

## Consequences

**Positive:**
- ADR-V3-016 pilot-gate matrix is now 8/8 (with item 5 done · item 5 was deferred but no longer)
- Trivially defends against bot abuse, broken client retry storms, accidental loops
- Per-actor isolation prevents one runaway client starving others
- Retry-After header gives clients deterministic backoff (industry standard)
- Default-disabled means no surprise breakage on existing dev workflows

**Negative:**
- In-memory state · no persistent enforcement across restarts (acceptable · reset on restart is the desired UX)
- Bucket-key fallback to remote_addr is weak behind shared proxies (NAT + reverse proxy) · pilot-time mitigation: configure proxy to set `X-Forwarded-For` and parse it (Sprint 10 if needed)
- Simple counter without Redis · doesn't scale beyond single host (Plan v3 §F: single-host pilot is the explicit scope)

## Verification

Spec-first per ADR-V3-011 §1:

1. **Failing tests FIRST:** `services/http_surface/test_rate_limit.py` (5 tests) · 4 fail on first run because `rate_limit_per_min` constructor arg doesn't exist yet
2. **Implementation:** `_consume_token` helper + dispatch hook + 429 sender in `services/http_surface/server.py`
3. **All 5 tests PASS** + 35/35 Python total (no regressions)
4. **Live verification (operator-facing example):**
   ```sh
   XCP_RATE_LIMIT_PER_MIN=60 \
   XCP_HMAC_SECRET=... \
   python3 -m services.http_surface --port 8769
   # Burst 61 invocations from same actor_id → 61st returns 429 with Retry-After
   ```

## Pilot-readiness gate · final state

| ADR-V3-016 item | Status | Sprint |
|---|---|---|
| 1 · HMAC token validation | ✅ | Sprint 6 |
| 2 · Scoped CORS allowlist | ✅ | Sprint 6 |
| 3 · Structured access log | ✅ | Sprint 6 |
| 4 · Deny event emission | ✅ | Sprint 6 |
| 5 · Rate limit | ✅ | Sprint 9 (this ADR) |
| 6 · LaunchAgent + watchdog | ✅ | Sprint 8 |
| 7 · Health probe expansion | ✅ | Sprint 8 |
| 8 · Body size limit | ✅ | Sprint 8 |

**8/8 done.** Pilot path fully unblocked engineering-side.

## Open questions (Sprint 10+)

- X-Forwarded-For parsing for behind-proxy actor identification
- Per-skill / per-workspace rate tiers
- Distributed rate limit if multi-engine deploy lands
