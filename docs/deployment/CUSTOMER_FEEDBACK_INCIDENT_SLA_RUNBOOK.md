# Customer-Feedback Incident And SLA Runbook

Status: non-production customer-feedback control.

This runbook governs Xlooop customer-feedback mode on Cloudflare Pages while
private/customer Operator mode remains blocked. It is intentionally stricter
than the commercial demo gate: a commercial walkthrough can be green while
private operations remain blocked.

## SLA Controls

| Control | SLA | Owner | Stop Condition |
|---|---:|---|---|
| OperationsLiveStream freshness | 900 seconds unless overridden by environment | Xlooop owner/operator | `freshness_stale` event or expired freshness lease before deploy |
| Cloudflare Access authentication | fail closed | DevSecOps / owner admin | any unauthenticated customer-feedback API success |
| D1 proposal persistence | request acknowledged or explicit 503 | Xlooop owner/operator | silent loss of proposal or receipt evidence |
| Customer-safe redaction | 0 leakage findings | Risk / owner admin | any MB-P private path, internal rule id, secret, raw customer private marker, or private engine term |
| Customer-feedback Operator mode | proposal-only by default | Owner admin | receipt created for customer-feedback user without explicit Operator entitlement |

## Monitoring Events

Every customer-feedback backend control must emit or expose one of these events:

- `auth_denied`
- `tenant_denied`
- `redaction_blocked`
- `proposal_created`
- `receipt_created`
- `freshness_stale`
- `api_error`

Events are stored in `customer_feedback_monitoring_events` and surfaced through
aggregate company telemetry. Raw tenant content is not included in monitoring
event detail.

## Leakage Stop Condition

This section is the leakage stop condition for customer-feedback mode.

If a customer-facing response, export, feedback payload, health report, or value
report contains private MB-P paths, internal rule IDs, secrets, raw customer
private markers, or private engine terms:

1. Disable customer-feedback Operator mode.
2. Stop deploys to customer-feedback.
3. Record `redaction_blocked`.
4. Preserve the failing payload as redacted evidence only.
5. Notify owner/admin.
6. Re-run the redaction verifier before reopening.

## Rollback

Rollback is a Cloudflare Pages deployment revert plus D1 write freeze for
mutating customer-feedback routes. The latest redacted deployment receipt must
name build SHA, environment, Access posture, freshness receipt, and customer-safe
manifest.

## Claim Gate

No production SaaS claim, private customer operations claim, autonomous
operations claim, validated ROI claim, or guaranteed savings claim is permitted
until backend auth, tenant entitlement, redaction, monitoring, incident/SLA,
legal, and commercial claim sign-off all pass.

## Production Boundary Receipt

Private/customer Operator mode is closed only when the deployed environment has
a fresh production-boundary receipt at:

`docs/deployment/evidence/latest-customer-feedback-production-boundary-receipt.json`

The receipt must use schema
`xlooop.customer_feedback_production_boundary_receipt.v1` and prove:

- Cloudflare Access JWT positive and negative checks.
- `/api/session` positive and unauthenticated fail-closed checks.
- D1 proposal write/read evidence.
- Customer-feedback default receipt denial.
- Owner aggregate telemetry without raw tenant content.
- Redaction scan across customer-facing API responses/exports.
- Monitoring events present.
- Incident/SLA owner.
- Legal/commercial claim sign-off reference.
- `checked_at` and `ttl_expires_at`.

Run:

```bash
npm run verify:customer-feedback-production-boundary
npm run verify:customer-feedback-production-boundary:strict
```

The non-strict verifier is allowed to pass while reporting
`blocked_until_cloud_and_signoff_evidence`; the strict verifier must fail until
the cloud receipt exists, is fresh, and passes every required check.
