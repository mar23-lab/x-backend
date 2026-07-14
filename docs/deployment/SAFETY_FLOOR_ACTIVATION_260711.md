# Safety-floor activation — 260711 (SF wave)

The safety floor closes the publicly-exploitable gaps the MB-P commercial triage flagged
("a bot can sign up unbounded; the isolate rate-limit is bypassable; cron failures are silent").
**The code is landed and dormant-safe.** This file is the operator activation — each step flips a
currently-inert, already-wired path live. Tick + date on completion.

## What landed in code (this wave — no behavior change until you activate)
- **Cron→Sentry (SF-1):** the scheduled dispatcher now reports to Sentry — `captureException` on a
  thrown cron, `captureMessage` on a `status:'failed'` result (routine `degraded`/`skipped` stay quiet),
  and flushes on every exit. Rule extracted to `lib/cron-observability.ts` + tested. **This is LIVE the
  moment it deploys** because `SENTRY_DSN` is already bound (delivery confirmed 260707) — no activation
  step needed beyond the deploy. Closes the silent-cron class (the reclassify/executor loop failing
  invisibly = the "proceed did nothing" keystone-trust incident).
- **Rate-limit safety cap (SF-2):** `SAFETY_FLOOR_RATELIMIT_ENABLED` (default OFF = byte-identical) gates
  a per-user cap on the two LLM-cost endpoints — `customer-chat` (60/min/user) and `readiness/*`
  (10/min/user). Defense-in-depth for "an authed user drives unbounded LLM spend" until per-tenant
  metering exists.

## Operator activation steps

### 1 · Durable signup rate-limiter (fixes the bypassable in-isolate limiter)
The `/request-access` limiter already exists (5/min/IP) but falls back to an **in-memory Map that resets
per isolate** = bypassable. Make it durable:
1. In `wrangler.toml`, uncomment the block at lines ~67-70:
   ```toml
   [[ratelimit]]
   name = "RATE_LIMITER_SIGNUP"
   namespace_id = "2001"
   simple = { limit = 5, period = 60 }
   ```
2. `npm run deploy:api` → the code resolves the binding by name automatically (`rate-limit.ts` checkBucket).
3. Verify: hammer `POST /api/v1/request-access` from one IP >5×/min → 429 that **persists across isolates**.

### 2 · Turnstile (bot-check on the public signup funnel)
Server-side verification is **already built + wired** into `/request-access` (`services/turnstile.ts`,
403 `TURNSTILE_FAILED` on bad token). Dormant because the secret is unset (secret-unset → skipped → funnel open).
**Order matters — do the front-end FIRST or the funnel hard-403s every real user:**
1. **x-web (front-end/operator):** render the Turnstile widget on the request-access form with the SITE key,
   so real users produce a token. (Cross-repo — x-web, not this repo.)
2. `wrangler secret put TURNSTILE_SECRET` (the paired secret key). After this, tokenless bots 403; real users pass.
3. Verify: request-access without a token → 403 `TURNSTILE_FAILED`; with a valid widget token → 200.

### 3 · Cron→Sentry (SF-1) — just deploy
Already-bound `SENTRY_DSN` means SF-1 reports the moment the worker deploys. No secret/binding step.
1. Confirm `SENTRY_DSN` still bound (it is — see the deploy receipt observability block).
2. After the wave deploys, verify: force a cron error (or wait for a real one) → it appears in Sentry Issues
   tagged `kind:cron_threw` / `kind:cron_failed_status` (previously invisible).

### 4 · Rate-limit safety cap (SF-2) — flip after step 1
Flip `SAFETY_FLOOR_RATELIMIT_ENABLED=true` (dashboard var, no redeploy) once the durable binding (step 1) is
provisioned, so the per-user caps use the distributed store rather than the in-isolate fallback.
1. Set the var → `customer-chat` capped 60/min/user, `readiness` 10/min/user.
2. Verify: exceed 60 chat calls/min as one user → 429 `RATE_LIMIT_EXCEEDED` bucket `route`; a second user unaffected.
3. Rollback: unset the var (instant, no redeploy).

## Sequencing (from the COMMERCIAL_APPROVAL_CHECKLIST)
Safety floor (steps 1-4) → per-tenant metering → Stripe → then the pricing/self-serve flag flips
(`ENTITLEMENT_ENFORCEMENT`, `CUSTOMER_AUTO_PROVISION_*`, etc.). Do NOT open self-serve before step 1+2 are live.
