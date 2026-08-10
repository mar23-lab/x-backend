# Xlooop Cloudflare Paired Deployment Plan

Status: production surfaces exist; public self-serve remains blocked until live authority gates pass.

## Canonical Surfaces

| Surface | Domain | Runtime | Source authority | Production mutation |
|---|---|---|---|---|
| Customer app | `https://app.xlooop.com` | Cloudflare Pages | `x-ai-front/app` React/Vite artifact | `deploy:paired:prod` |
| Customer API | `https://api.xlooop.com` | Cloudflare Worker | `x-backend` | `deploy:paired:prod` |

`x-ai-front/wired` is a test/reference donor and is not deployable commercial authority.
The Worker and Pages surfaces form one versioned product pair. A successful deploy is not by itself
public-self-serve authority.

## One Production Entrance

All production aliases converge on the paired orchestrator:

```text
deploy:api -------+
deploy:app:prod --+--> deploy:paired:prod --> API deploy/ratify --> Pages deploy/ratify
                  |                                      failure --> compensating rollback
```

Standalone Pages production mutation is refused. The paired orchestrator reserves both short-lived,
single-use approval packets before calling Cloudflare. The API packet, Pages packet, and immutable
release manifest must agree on:

- cutover id;
- backend and frontend SHAs;
- API contract hash;
- database schema head;
- feature posture;
- frontend artifact digest;
- API Worker rollback target and Pages deployment rollback target.

## Required Sequence

1. Build the React/Vite production artifact from a clean, committed `x-ai-front` checkout.
2. Assemble the immutable Pages release in the exact clean backend checkout:

   ```bash
   XLOOOP_FRONTEND_ARTIFACT_DIR=/absolute/path/to/x-ai-front/app/dist \
     npm run prepare:app:prod
   npm run verify:app-pages-release
   ```

3. Mint exact API and Pages decision packets from the approved candidate and rollback tuple.
4. Run the local authority stack and the paired cutover self-test.
5. Set the decision packet paths and execute the only production command:

   ```bash
   XLOOOP_AUTHORITY_DECISION_PACKET=/absolute/path/to/api-approved.json \
   XLOOOP_APP_PAGES_DECISION_PACKET=/absolute/path/to/pages-approved.json \
     npm run deploy:paired:prod
   ```

6. Preserve the ratified paired receipt. Verify authenticated customer journeys, API/MCP identity,
   security headers, telemetry, lifecycle receipts, and rollback evidence.

## Local Release Authority

GitHub Actions is not release authority while runs can terminate before checkout and provide no
application-step evidence. Active workflow YAML remains disabled and historical templates remain in
`deployment/github-actions-disabled`.

Cloudflare Workers Builds is also not paired release authority unless it is explicitly rewired to:

- consume the same single-use API and Pages approvals;
- verify the exact frontend artifact and backend tuple;
- deploy both surfaces in the governed order;
- ratify both surfaces;
- execute the declared compensating rollback pair on failure;
- emit the same immutable receipt chain.

Until that exists, a remote Cloudflare check is telemetry, not a production decision.

## Secrets And Identity

- Cloudflare credentials remain in operator secret storage and never enter source, docs, or receipts.
- Model runtime credentials use the versioned tenant keyring and write-only Settings/API paths.
- Customer agents enter through the canonical `xcp-gateway` customer profile and call
  `xcp_session_start` once.
- Every request rechecks token validity, tenant membership, RBAC, scopes, and revocation.
- External agents never receive raw graph authority, MB-P governance internals, broad memory, or secrets.

## Public Self-Serve Stop Conditions

Do not claim public self-serve readiness until all of these have live authority:

- exact API/app pair ratified on production;
- production database and application-role RLS proof;
- API/MCP live lifecycle and revocation proof;
- production object-storage delete/export/legal-hold receipt;
- 24-48 hour two-company pilot with zero tenant leakage, raw graph exposure, revocation bypass, and
  unapproved writes;
- live provider execution or typed unavailable behavior for every conversational route;
- customer-critical Settings and onboarding controls proven against backend receipts.

## Verification

```bash
npm run verify:github-actions-disabled
npm run verify:orchestrator-script-contracts
npm run verify:cloud-deployment-readiness
npm run verify:cloudflare-deployment-signal
npm run verify:deployed-surfaces
npm run verify:deploy-provenance
npm run verify:deploy-schema-head
npm run verify:frontend-pair:self-test
npm run verify:rollback-target-authority:self-test
npm run verify:app-pages-release:self-test
npm run deploy:paired:prod:self-test
npm run verify:public-production-readiness-hard-stop
```

The last command may correctly report that public authority is absent while internal controls pass.
Never convert missing live evidence into a synthetic success receipt.
