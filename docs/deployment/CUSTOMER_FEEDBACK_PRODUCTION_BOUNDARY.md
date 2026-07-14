# Customer-Feedback Boundary Evidence

This boundary is proposal-only customer-feedback evidence. It does not approve
production SaaS, private customer Operator mode, autonomous operations, raw
tenant access, validated ROI, or unrestricted source writeback.

Use the receipt writer to refresh the strict boundary receipt before its TTL
expires:

```sh
export CLOUDFLARE_ACCESS_CLIENT_ID='...'
export CLOUDFLARE_ACCESS_CLIENT_SECRET='...'
export XLOOOP_LEGAL_CLAIM_SIGNOFF_REF='owner-approved-non-production-customer-feedback-proposal-only-no-production-saas-claim-YYYYMMDD'
export XLOOOP_OWNER_TELEMETRY_PROOF_REF='owner-admin aggregate telemetry proof or ticket/ref'
npm run write:customer-feedback-production-boundary-receipt
npm run verify:customer-feedback-production-boundary:strict
```

`npm run evidence:customer-feedback:renew` is the canonical renewal alias for
the same writer. Run it before `ttl_expires_at`; stale receipts are not valid
customer/private Operator evidence.

The writer performs Cloudflare Access negative and positive checks, session
JSON verification, D1 feedback write/read/patch, proposal creation, customer
receipt denial, customer-feedback health/redaction checks, customer telemetry
denial, owner aggregate telemetry proof, and monitoring-path evidence. It must
not record tokens, cookies, secrets, or private local paths in the receipt.

Operations live stream evidence is separate from this boundary receipt. Before
preview, deploy, or commercial readiness, run:

```sh
npm run ensure:operations-live-stream-fresh
```

For a local heartbeat, run:

```sh
npm run operations-live-stream:heartbeat
```

The heartbeat renews the stream before the `900s` freshness SLA expires. Read-only
verifiers must not refresh tracked evidence automatically; when stale they report
`stale_needs_refresh` and print the renewal command.
