---
owner: xlooop-backend
freshness: review_before_each_activation
verifier: npm run ci-local; focused tenant-projection-queue tests; dry-run bundle
consumers: backend operators, release reviewers, incident responders
status: staged_not_approved
---

# Tenant Projection Queue Activation

This runbook prepares the event-driven tenant graph projection lane. It does not authorize resource
creation, migration application, deployment, flag activation, authority transfer, or cutover. Marat must
approve each production-affecting action separately.

## Contract

1. Single-intake execution commits its effect, governed receipt, and `projection_outbox` row atomically.
2. The five-minute dispatcher claims bounded rows and sends only `outbox_id`, `workspace_id`, schema and
   event type to Cloudflare Queue. No raw payload or customer content leaves the database boundary.
3. The consumer binds every operation to both outbox and workspace identifiers, rebuilds only that
   workspace's derived graph, then marks the outbox row processed.
4. Delivery is at-least-once. Duplicate messages are safe because projection is deterministic and a
   processed outbox row is acknowledged without reprocessing.
5. Failures retry with bounded exponential backoff. Exhausted messages land in the DLQ and become durable
   `dead_letter` rows rather than disappearing.

## Prerequisites

- Migrations 075 and 076 pass on an isolated integration database; neither is auto-applied.
- Live RLS tests pass with the restricted application role.
- Queue `xlooop-tenant-projection` and DLQ `xlooop-tenant-projection-dlq` exist in a non-production account.
- Producer binding name is `TENANT_PROJECTION_QUEUE`.
- Main consumer has an explicit DLQ, bounded batch size, retry delay and maximum retries.
- The same Worker consumes the DLQ so database state records exhausted delivery.
- `TENANT_PROJECTION_QUEUE_ENABLED` remains absent or false until the canary is approved.

Recommended staged Wrangler shape after resource approval:

```toml
[[queues.producers]]
binding = "TENANT_PROJECTION_QUEUE"
queue = "xlooop-tenant-projection"

[[queues.consumers]]
queue = "xlooop-tenant-projection"
max_batch_size = 25
max_batch_timeout = 5
max_retries = 5
retry_delay = 30
dead_letter_queue = "xlooop-tenant-projection-dlq"

[[queues.consumers]]
queue = "xlooop-tenant-projection-dlq"
max_batch_size = 25
max_batch_timeout = 5
```

## Canary Evidence

Use a non-production tenant and one intake execution. Required evidence:

- one committed execution receipt and one pending outbox row;
- one Queue message containing no payload/customer text;
- one processed outbox row with `attempt_count >= 1`;
- one fresh graph snapshot containing the resulting canonical task packet;
- duplicate delivery produces no duplicate authoritative object;
- forced transient failure retries and subsequently succeeds;
- forced terminal failure reaches the DLQ and records `dead_letter`;
- a message with mismatched workspace/outbox identifiers cannot project another tenant;
- projection latency p95 is at most 60 seconds during the pilot-shadow soak.

## Rollback

1. Set `TENANT_PROJECTION_QUEUE_ENABLED=false` or remove it. The dispatcher performs zero DB work.
2. Pause the main Queue consumer. Do not purge either queue.
3. Preserve pending/dispatched/dead-letter rows for diagnosis and replay review.
4. The hourly drift reconciliation remains the operator-only backstop; customer projection authority does
   not switch as part of this runbook.

## Approval

```yaml
operator_approval:
  approved: false
  approved_by: null
  approved_at: null
  scope: null
```
