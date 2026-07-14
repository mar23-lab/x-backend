# ADR-V3-019 · HTTP HMAC + replay window + scoped CORS + access log + deny attestation

**Status:** Accepted 2026-05-07 · Sprint 6
**Date:** 2026-05-07
**Decision-makers:** Marat
**Cross-link:** [ADR-V3-015](ADR-V3-015-cross-repo-http-boundary.md), [ADR-V3-016](ADR-V3-016-http-surface-security-deferral.md), [ADR-V3-018](ADR-V3-018-skills-bridge-over-http.md), Plan v3 §V Confidentiality Boundary, Plan v3.5 Sprint 6

## Context

ADR-V3-016 deferred 5 HTTP surface security items behind a "pilot gate". Sprint 6 closes 4 of them (HMAC + replay + scoped CORS + access log + deny attestation) · rate limit deferred to Sprint 6.5 because the threat model doesn't yet justify it (single actor today). This ADR records the chosen schemes and the rationale.

Sprint 6 was also the first feature to honour ADR-V3-011 §1 (failing-spec-first) cleanly: 5 vitest tests + 10 Python tests landed FAILING, then the implementation made them pass.

## Decision

### HMAC scheme · shared-secret SHA-256 with timestamp

**Wire shape:**

```
Headers:
  X-XCP-Token:     hex(HMAC-SHA-256(secret, message))
  X-XCP-Timestamp: epoch-seconds at request time
```

**Canonical message:**
```
${timestamp}.${method}.${path-with-query}.${body || ''}
```

**Server validation order:**
1. Token + timestamp headers present (else 401)
2. Timestamp parses to integer (else 401)
3. Replay window check: `|now − ts| < 300s` past, `< 30s` future (else 401)
4. Nonce cache check (in-memory deque · max 1000 entries · drops oldest)
5. HMAC matches expected (`hmac.compare_digest`) (else 401)
6. Pass to route handler

**Why this scheme:**
- Plan §V already cites HMAC-SHA-256 → aligned
- xcp-engine already uses SHA-256 + HMAC for attestation chain → familiar code path
- Stdlib only (`hmac` + `hashlib`) → no new pip dep
- Simpler than JWT for service-to-service · forward-compatible (later sprints add JWT alongside for human users)
- Demo and substrate use WebCrypto `crypto.subtle.sign` · no JS deps

**Why not JWT for Sprint 6:**
- Adds claims/issuer/audience complexity not needed for service-to-service
- Would push toward JWT library install (jsonwebtoken / jose)
- Harder to audit · requires understanding JWS/JWE separately
- Better to ship HMAC now · layer JWT later for distinct user identity

### Replay protection · 5-minute window + nonce cache

**Window (`HMAC_REPLAY_WINDOW_SECONDS = 300`):** matches AWS Sig v4, Stripe webhooks, Slack signing secrets · industry-standard tolerance for clock skew across geographically separated client/server.

**Future skew tolerance (`HMAC_FUTURE_SKEW_SECONDS = 30`):** allows clients with clocks slightly ahead but rejects requests claiming to be from far in the future (suspicious).

**Nonce cache (`HMAC_NONCE_CACHE_SIZE = 1000`):** in-memory deque of recent (token, timestamp) tuples. Catches identical-replay attacks within the window. Bounded · drops oldest. Stateless across server restart by design (the timestamp window already gives 5-min protection on its own; the nonce cache is belt-and-braces).

**What replay protection prevents (operator-facing summary in commit msg):**
- Network sniff replay (open WiFi, MITM proxy)
- Server access-log leak replay
- Support-ticket attachment replay
- Stolen-device cached-request replay

**What it does NOT prevent:**
- Live attacker with the HMAC secret (key-rotation problem · separate)
- Replays inside the 5-min window (acceptable trade-off for clock-skew tolerance)
- Token-stripping over HTTP (TLS handles transport)

### Scoped CORS

**Resolution algorithm:**
- `XCP_HTTP_CORS_ORIGIN='*'` → echo `*` (dev-only · permissive)
- `XCP_HTTP_CORS_ORIGIN='http://x'` → match request `Origin` header · echo back if match · else echo `http://x` as fallback
- `XCP_HTTP_CORS_ORIGIN='http://a,http://b'` → comma-list of allowlisted origins · same matching rule

**Headers exposed:** `content-type, x-xcp-token, x-xcp-timestamp` (added the two new HMAC headers to the allowlist).

**OPTIONS preflight:** explicit handler · returns 204 + the resolved CORS headers.

### Structured access log (JSONL)

**Format:** one JSON object per line, written to `XCP_ACCESS_LOG` path (default unset = no log):

```json
{"ts":"2026-05-07T11:14:22Z","method":"POST","path":"/api/v1/skills/invoke","query":"","status":200,"latency_ms":347,"remote_addr":"127.0.0.1"}
```

**Captured for every request** (success, deny, 401, 500). Log write failure must NEVER break the response (try/except wraps the write).

**Not captured (out of scope for Sprint 6):**
- Request body (potential PII; defer to dedicated structured event log if needed)
- Response body (large)
- HMAC token / timestamp (not actionable in audit; would log secrets if scheme changes)

### Deny attestation block

**Trigger:** every `POST /api/v1/skills/invoke` with `unknown skill_id` (and future · policy-gate denials within `LLMBridge.dispatch`) writes an `AttestationRow` with `verify_status='denied'` to `~/.xcp-demo/evidence.db`.

**Schema migration:** added `verify_status TEXT NOT NULL DEFAULT 'completed'` column to `attestation_blocks`. Migration is idempotent · checks `PRAGMA table_info` before `ALTER TABLE ADD COLUMN`.

**Why this matters:** without it, the attestation chain only records SUCCESSFUL invocations · audit trail is half-deaf. Plan §V cites "HMAC-SHA-256 attestation chain" as the load-bearing claim · denials must be in the chain too.

### Deferred from Sprint 6 to 6.5

- **Rate limit per actor_id** · not justified at single-actor scale · easy to bolt on later
- **Body size limit (1 MB default)** · trivial to add when the threat surfaces
- **HMAC key rotation** · operator-managed for now (env var swap + restart)

## Consequences

**Positive:**
- Plan §V Confidentiality Boundary now has runtime evidence · pilot gate items 1-4 closed
- Replay protection is industry-standard pattern · audit-friendly
- Backwards compatible: server with no `XCP_HMAC_SECRET` env still works (dev mode)
- Substrate `HttpEvidenceStorePort` adds `hmacSecret` opt · same pattern works on demo + future control-plane
- 5-minute window + nonce cache + signature-mismatch rejection cover the realistic threat model

**Negative:**
- Secret management is operator's responsibility · plain env var for now (pilot prep ADR-V3-016 §6 covers keychain story)
- Server-side nonce cache resets on restart · no persistent dedup (acceptable · timestamp window covers)
- Stdlib `http.server` is single-threaded → HMAC verification blocks the loop briefly (microseconds; not a real concern)
- Schema migration on existing dbs adds one column · benign · backfill defaults to `'completed'`

**Out of scope:**
- TLS termination (operator's reverse proxy)
- mTLS (enterprise tier · post-pilot)
- OAuth2 / SAML (post-pilot · multi-user identity)
- Streaming responses (deferred to Sprint 7+)

## Verification

Spec-first per ADR-V3-011 §1:

1. **Failing specs land FIRST:**
   - `xcp-platform/apps/intent-ai-app-template/src/services/evidence-store-port/HttpEvidenceStorePort.security.test.ts` · 5 tests · 3 fail on first run
   - `xcp-platform/packages/xcp-engine/services/http_surface/test_security.py` · 10 tests · ALL FAIL on first run

2. **Implementation:**
   - TS: `HttpEvidenceStorePort.ts` · `hmacSecret` opt · `_signMessage` (WebCrypto) · `_securityHeaders` injected into `_get`/`_post`
   - Python server: HMAC verifier + replay window + nonce cache + scoped CORS resolver + access log JSONL writer + deny attestation
   - Schema: `verify_status` column added to `attestation_blocks` · idempotent migration

3. **Tests after implementation:**
   - 44/44 vitest pass (5 new + 39 prior)
   - 16/16 Python pass (10 new + 6 Sprint-5)

4. **Live verification (next step):** demo at `?source=engine&hmac=<dev-secret>` invokes a skill against the protected engine · attestation persists · access log writes JSONL.

## Operational notes

**Start the engine with HMAC enabled:**

```sh
export XCP_HMAC_SECRET="dev-secret-do-not-use-in-prod"
export XCP_HTTP_CORS_ORIGIN="http://localhost:8768"
export XCP_ACCESS_LOG="$HOME/.xcp-demo/access.log"
cd /Users/maratbasyrov/WIP/xcp-platform/packages/xcp-engine
PYTHONPATH=. python3 -m services.http_surface --port 8769
```

**Demo URL with HMAC:**
```
http://localhost:8768/v3/?source=engine&hmac=dev-secret-do-not-use-in-prod
```

**Access log inspection:**
```sh
tail -f ~/.xcp-demo/access.log | jq .
```

## Open questions (carry-over to Sprint 6.5 / 7)

- Rate limit policy (token bucket per actor_id · default rate)
- HMAC secret rotation procedure (operator runbook)
- Per-workspace secret map (single secret today · multi-tenant later)
- Body size limit + 413 response
- Streaming invocation responses (Sprint 7+)
