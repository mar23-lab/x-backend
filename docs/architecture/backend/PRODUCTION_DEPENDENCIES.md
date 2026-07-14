# Production dependencies — xlooop-api worker (SSOT, verified 2026-07-06)

Grounded inventory of everything the production backend depends on: secrets, flags, crons, and the
external read-model pipeline. Verified against the live deploy (`build 965d33a7+`) and a full authed
endpoint sweep (all 200/403-correct, zero 5xx). Companion: [API_CONTRACT_V1.md](API_CONTRACT_V1.md).

## 1 · FAIL-class secrets (absence = hard failure)

| Secret | Used by | Behaviour if absent |
|---|---|---|
| `DATABASE_URL` | DAL bind (index.ts), every route | all authed routes 503 |
| `CLERK_SECRET_KEY` | JWT verify (middleware/auth.ts), Clerk API calls | all authed routes 401/503 |
| `MBP_OWNER_USER_ID` | mbp-projection routes; cron owner-identity set | mbp-projection 503; ops-queue never drains |
| `MBP_LIVE_STREAM_INGEST_TOKEN` | POST /mbp-live-stream/ingest | live-stream ingest 503 |
| `OPERATIONAL_SPINE_PACKET_SIGNING_SECRET` | MCP task-packet HMAC (mcp-gateway.ts) | GET /mcp/task-packets/:id 503 |

## 2 · DEGRADE-class secrets (absence = graceful fallback)

| Secret | Degrades to |
|---|---|
| `XLOOOP_RLS_APP_DATABASE_URL` | owner connection (RLS 2nd layer inert; app-WHERE still scopes) — **SET in prod (043–047 live)** |
| `ANTHROPIC_API_KEY` | chat falls back to Workers-AI Llama → deterministic floor — **SET in prod 260706** |
| `GITHUB_WEBHOOK_SECRET` / `_REPO_MAP` / `_DEFAULT_WORKSPACE` | webhook unsigned / fallback-workspace routing |
| `RESEND_API_KEY` + email vars | email notifications suppressed |
| `RATE_LIMITER` binding | per-isolate token bucket (no global limit) |
| canary token SHA vars | canary service principal cannot auth |
| Sentry vars | error tracking off |

## 3 · Feature flags (prod values verified from live deploy output 260706)

| Flag | Prod | Gates |
|---|---|---|
| `EXECUTOR_MODE` | `enabled` | hourly :45 operations-queue drain |
| `RECLASSIFY_CRON_ENABLED` | `true` | hourly :45 unattributed-event self-heal |
| `DIGEST_SWEEP_ENABLED` | `true` | digest sweep |
| `ENRICHMENT_SWEEP_ENABLED` | `true` | packet enrichment |
| `CLERK_INVITATIONS_ENABLED` | `true` | investor magic-link invites |
| `CUSTOMER_SELF_SERVICE_ENABLED` | `true` | customer self-service surface |
| `PURGE_DELETED_ENABLED` | OFF (default) | daily 04:00 hard-purge of >30d-archived xlooop events (deliberately off) |
| `CUSTOMER_API_TOKENS_ENABLED` / `CUSTOMER_OPERATIONAL_TOKENS_ENABLED` | unset (off) | customer API-token mint (activation = operator-named) |

## 4 · Worker crons (registry: src/workers/crons/index.ts · dispatcher: src/workers/index.ts)

| Schedule | Loop | Flag |
|---|---|---|
| `*/5 * * * *` | propagation tick | — |
| `0 * * * *` | permanent-suppress + graph rebuild | — |
| `0 4 * * *` | threshold-retune + purge-deleted | purge: `PURGE_DELETED_ENABLED` |
| `30 4 * * *` | pattern suspend | — |
| `0 5 * * *` | calibration retrain | — |
| `15 5 * * *` | shadow eval | — |
| `0 3 * * 1` | weekly weight retune | — |
| `45 * * * *` | reclassify + ops-queue drain | `RECLASSIFY_CRON_ENABLED` / `EXECUTOR_MODE` |

## 5 · The MB-P read-model pipeline (the "Read-model · stale" pill)

The cockpit's MB-P projection (`data/mbp-operations-projection.json`) is NOT produced by this worker:

1. **Producer** (MB-P repo, operator machine): launchd `io.mbp.xlooop-projection-cron` daily 03:30 →
   `_sys/scripts/wrappers/rerun_xlooop_projection.sh` → `export_mbp_to_xlooop_projection.py` →
   writes to `MB-P/_sys/xcp-system/cross_repo_drafts/Xlooop-XCP-demo/data/` (24h validity).
2. **Stager** (session action, boundary-by-design): `npm run ensure:mbp-projection-fresh` copies the
   draft into this repo's `data/`; commit + app deploy makes the pill fresh.
3. **Gate:** `verify-projection-cron-liveness.mjs` (ci-local WARN tier, 48h threshold).

**Known failure modes (diagnosed 260706):**
- Producer output is a git-TRACKED file in the shared MB-P checkout — a parallel session's
  checkout/restore REVERTS the fresh export to the committed (stale) version. Recommendation: untrack
  the `cross_repo_drafts/Xlooop-XCP-demo/data/` outputs in MB-P (derivative, not source) so git ops
  can't revert them.
- The staging never happens unless a session runs it → pill ages past 48h. Recommendation: run
  `npm run commercial:preflight` (which includes ensure-fresh) as part of any app deploy.
- `ensure-mbp-projection-fresh.mjs` prints a FALSE "still stale" verdict when the staged copy is fresh
  (timezone comparison bug — it compares `+10:00` timestamps incorrectly); the authoritative check is
  `verify-projection-cron-liveness.mjs`. Fix candidate, low priority.

## 6 · External service dependencies

| Service | Used for | Failure blast radius |
|---|---|---|
| Neon Postgres `flat-truth-23350426` (Sydney) | all data (RLS on 5 customer tables + 15 subsystem) | total |
| Clerk | auth (JWT, orgs, OAuth connectors) | all authed traffic |
| Cloudflare Workers AI | free-tier chat (Llama) | chat degrades to deterministic floor |
| Anthropic API | premium chat (`claude-sonnet-4-6`, opt-in via model picker) | falls back to Llama |
| Cloudflare Pages (`xlooop-app`) + Worker (`xlooop-api`) | frontend / backend | total |
| GitHub / Google / Dropbox / Microsoft OAuth apps | source connectors | connector-specific |

## 7 · Deploy safety

`npm run deploy:api` runs `predeploy:api` → `scripts/verify-deploy-sha-current.mjs`: FAILS unless
`HEAD == origin/main` (ls-remote ground truth; override `XLOOOP_DEPLOY_SHA_OVERRIDE=1`). Always verify
`curl api.xlooop.com/api/v1/health` `.build` equals the intended SHA after deploy.
