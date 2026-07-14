# Xlooop Test Feedback Annotations

Status: implemented for dev/test feedback capture. Backend persistence requires a Cloudflare D1 binding named `FEEDBACK_DB`.

## User Flow

1. Tester enables `Feedback mode`.
2. Every click is captured as an annotation target instead of activating the control.
3. The popover records category, severity, comment, UI target, route, and graph path.
4. The client posts to `/api/feedback`.
5. If D1 is configured, the backend stores it in `feedback_annotations`.
6. If the backend is unavailable, the redacted packet is queued in local storage and remains visible in the owner queue.

## Required Cloudflare Setup

- Run `node scripts/provision-feedback-d1-cloudflare.mjs --env=both` from a shell
  with Cloudflare environment variables set.
- The provisioner creates or reuses:
  - `xlooop-feedback-dev`
  - `xlooop-feedback-test`
- It binds the database to the matching Cloudflare Pages project as `FEEDBACK_DB`.
- It applies `migrations/0001_feedback_annotations.sql`.
- It also applies `migrations/0002_customer_feedback_authority.sql` before
  customer-feedback proposal/receipt APIs are enabled.
- It sets `FEEDBACK_REQUIRE_ACCESS=1` so persisted reads/writes require a Cloudflare Access identity.
- It remotely verifies that the active customer-feedback hostname is covered by a Cloudflare Access self-hosted application with at least one allow policy.
- While `xlooop.com` DNS is not moved to Cloudflare, the active customer-feedback hostname is `xlooop-test.pages.dev`; after DNS moves, it becomes `test.xlooop.com`.
- Persisted feedback requires Cloudflare Access identity on whichever hostname is active because `FEEDBACK_REQUIRE_ACCESS=1`.

GitHub Actions is intentionally disabled while this private repository has no
paid/available Actions runner. Use the local provision/deploy path instead of
weakening the access boundary:

```bash
export CLOUDFLARE_ACCESS_ALLOWED_EMAILS="marat@example.com,tester@example.com"
npm run provision:cloudflare-pages-access:test
npm run deploy:cloudflare:test:local:feedback
```

Smoke verification:

```bash
npm run verify:feedback-cloud-smoke
npm run verify:feedback-cloud-smoke:remote
npm run verify:feedback-cloud-smoke:persist
```

The default smoke is static and safe. Remote mode verifies that the app/API is
either reachable or fails closed behind Cloudflare Access. Persist mode performs
write/read/patch against D1 and must only be run once Access identity or an
approved service-token posture is configured.

`safe-preview` deployment is allowed only for redacted watch-only review and does not make persisted feedback ready:

```bash
npm run deploy:cloudflare:test:local:safe-preview
```

Required local Cloudflare inputs:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_PAGES_PROJECT_XLOOOP_DEV`
- `CLOUDFLARE_PAGES_PROJECT_XLOOOP_TEST`
- Keep customer tenants Watch/proposal-only by default.

## Safety Boundary

The customer-visible path is label-based. The stored graph path is normalized and must not contain:

- local filesystem paths,
- secrets or API tokens,
- MB-P private governance paths,
- internal hard-rule identifiers.

The feedback access code remains routing only. Identity comes from Cloudflare Access; authorization comes from tenant entitlement. `xlooop-test.pages.dev` may be used for internal test execution only with the approved customer-safe manifest and Access protection.

## Owner Resolution Loop

Captured annotations start as `open` and can move through:

- `triaged`
- `linked`
- `resolved`
- `verified`

The current UI supports local triage/resolution immediately. Backend PATCH support is available when D1 is bound.

## Customer-Feedback Authority APIs

The same D1 binding stores the non-production customer-feedback authority
surface:

- `GET /api/session`
- `POST /api/proposals`
- `POST /api/receipts`
- `GET /api/telemetry/company`
- `GET /api/health/customer-feedback`

These APIs enforce the server-side chain:

`Cloudflare Access JWT -> identity -> app entitlement -> tenant membership -> role/permission -> Watch/Test/Operator -> proposal/receipt policy -> redacted response`.

Customer-feedback users remain Watch/Test and proposal-only by default. XCP is
default-denied unless an explicit `xcp` app entitlement exists. Marat can hold
the owner/operator roles and aggregate company telemetry scope, but raw tenant
content remains blocked unless audited break-glass or customer consent exists.
