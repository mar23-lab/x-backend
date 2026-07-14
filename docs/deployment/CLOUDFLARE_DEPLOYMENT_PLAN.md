# Xlooop Cloudflare Deployment Plan

Status: config-ready, external customer-feedback blocked until evidence is attached.

## Surfaces

Xlooop is the business operations cockpit. XCP is the second-level AI infrastructure control-plane entitlement owned by `xcp-platform`.

| Environment | Domain | Access | Data posture | Operator posture |
|---|---|---|---|---|
| `dev` | `dev.xlooop.com` | Cloudflare Access, internal owner only | Full MB-P owner operational proof allowed because it is not public | Owner/operator allowed through governed receipts |
| `test` | `test.xlooop.com` durable; `xlooop-test.pages.dev` while DNS is deferred | Cloudflare Access, named testers only | Redacted or owner-approved customer-safe export only | Watch/proposal-only by default |

`customer-feedback`, `feedback`, `staging`, and `production` are not active environment names.

## Deployment Flow

1. The operator checks out the committed release-visible artifact set locally.
2. `node scripts/verify-cloud-deployment-readiness.mjs` checks environment naming, claim posture, and XCP second-level gating.
3. `node scripts/verify-cloudflare-access-evidence.mjs` checks Cloudflare, tenant, and local deployment evidence structure.
4. For `test`, `node scripts/verify-cloudflare-access-remote.mjs --env=test` confirms the live Cloudflare Access app and allow policy. While `xlooop.com` DNS is deferred, the verifier checks `xlooop-test.pages.dev`; after DNS is moved, it checks `test.xlooop.com`.
5. `node scripts/prepare-cloudflare-pages.mjs --env=<dev|test>` creates `dist-cloudflare` from committed build artifacts. Connected Cloudflare builds may run `npm run build`, so the default `build` script delegates to `prepare:cloudflare-pages` and therefore defaults to `test`, the customer-safe watch/proposal-only environment.
6. `node scripts/deploy-cloudflare-pages-local.mjs` deploys `dist-cloudflare` with local Cloudflare environment variables and writes a deployment receipt.

The deployment workflow intentionally does not run `npm ci` or rebuild from
source because the current repository depends on local sibling packages for
development builds. Release truth is enforced before merge by
`verify:current-integrity`; cloud deployment consumes those committed artifacts.

## GitHub Actions Disabled And Local Deploy Authority

GitHub Actions is not part of the active deployment path while this private
repository has no paid/available Actions runner. Active workflows are therefore
disabled: `.github/workflows` must contain no YAML workflows. The old workflow
files are preserved as reference templates under:

```txt
deployment/github-actions-disabled/
```

Verify this posture with:

```bash
npm run verify:github-actions-disabled
npm run verify:cloud-deployment-readiness
npm run verify:cloudflare-deployment-signal
npm run verify:feedback-cloud-smoke
npm run verify:retrospective-closeout-composed
```

If GitHub reports a failed job with `steps: []` and no downloadable logs, the
workflow did not reach the checkout step. Treat that as external runner/account
state, not a failing application build. The correct response is not to weaken
deployment checks; it is to keep Actions disabled and use the local Cloudflare
deploy wrapper:

```bash
npm run deploy:cloudflare:test:local:feedback
```

If GitHub reports a failed third-party check named `Workers Builds: xlooop`,
treat it as Cloudflare Workers service configuration debt until the owner
disables or rewires that integration. The Xlooop deploy authority remains
Cloudflare Pages direct upload through the local wrapper, and the remote Workers
check must not be used as public/customer readiness evidence while
`data/cloudflare-deployment-signal.json` classifies it as external misbinding.

Observed Workers Builds trigger debt:

| Trigger | UUID | Observed build command | Observed deploy command |
|---|---|---|---|
| Deploy default branch (`main`) | `d3d4433c-d853-4c57-b3a5-9baadddd348e` | empty | `npx wrangler deploy` |
| Deploy non-production branches | `ba80550e-cd25-46f2-948b-bedf5181edeb` | empty | `npx wrangler versions upload` |

Those commands target the Workers service flow. This repository is a
Cloudflare Pages/static bundle flow: `wrangler.jsonc` declares
`pages_build_output_dir: "dist-cloudflare"`, and `npm run build` prepares that
directory. Do not add a Worker `main` entry point merely to satisfy the stale
Workers Builds trigger.

If the owner keeps these remote triggers, rewire both to the Pages contract:

```bash
npm run build
npx wrangler pages deploy dist-cloudflare --project-name=xlooop-test --branch=$WORKERS_CI_BRANCH
```

`wrangler` is declared as a dev deployment dependency so connected Cloudflare
builds do not depend on an interactive `npx` package install prompt before the
Pages deploy command can run.

The cleaner option is to disable/remove the stale Workers Builds integration
and keep the local Pages wrapper as release authority until a governed remote
CI/CD path is explicitly reinstated.

Every real local deploy writes a redacted receipt to:

```txt
docs/deployment/evidence/latest-cloudflare-local-deploy-receipt.<env>.json
```

The receipt records environment, mode, Pages project, deployment URL, git SHA,
and Access requirement. It must not record Cloudflare tokens, account secrets,
Access secrets, or local environment values.

This mode verifies the customer-safe manifest and live Cloudflare Access before
deploying. If Access is still deferred and the owner explicitly wants only a
redacted watch-only preview, use:

```bash
npm run deploy:cloudflare:test:local:safe-preview
```

Safe preview mode is not persisted feedback approval. Feedback writes should
continue to fail closed without Cloudflare Access identity.

Do not restore `.github/workflows/*.yml` until the owner explicitly decides to
pay for or otherwise enable GitHub Actions and `verify:github-actions-runner-infra`
passes on a fresh test run.

## Pages.dev Access While Custom DNS Is Deferred

While `xlooop.com` DNS remains outside Cloudflare, the active feedback test
hostname is `xlooop-test.pages.dev`. Provision or verify Access for that
hostname before persisted feedback testing:

```bash
export CLOUDFLARE_ACCESS_ALLOWED_EMAILS="marat@example.com,tester@example.com"
npm run provision:cloudflare-pages-access:test
npm run verify:cloudflare-access-remote -- --env=test
```

The provisioner creates or reuses a self-hosted Cloudflare Access application
for the currently active test hostname and adds an allow policy for named
testers. Do not use `everyone` for customer-feedback testing.

`test` preparation intentionally fails until `data/customer-safe-export-manifest.json` exists with `status: approved` and a customer-safe file allowlist. The no-arg Cloudflare build default also uses this same `test` gate; it must never fall back to `dev` or public/operator data.

## Required Local Cloudflare Configuration

Local environment variables:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_PAGES_PROJECT_XLOOOP_DEV`
- `CLOUDFLARE_PAGES_PROJECT_XLOOOP_TEST`

Do not store these values in deployment receipts or docs. GitHub repository
secrets may remain configured for later, but they are not the active deployment
authority while GitHub Actions is disabled.

## Feedback D1 Provisioning

Feedback annotations use Cloudflare Pages Functions plus D1:

- binding: `FEEDBACK_DB`
- dev database: `xlooop-feedback-dev`
- test database: `xlooop-feedback-test`
- migration: `migrations/0001_feedback_annotations.sql`
- access flag: `FEEDBACK_REQUIRE_ACCESS=1`

Run the local provisioner after the Cloudflare environment variables above
exist. The provisioner creates or reuses the D1 database, applies the migration,
binds `FEEDBACK_DB` to the Pages project, sets `FEEDBACK_REQUIRE_ACCESS=1` for
persisted feedback API calls, and verifies that the active customer-feedback
hostname has a live Cloudflare Access application with an allow policy before
customer-feedback D1 provisioning is treated as complete.

## Security Rules

The invitation/base64/code value is routing only. It is never authentication.

Real access requires:

- Cloudflare Access identity.
- Tenant entitlement record.
- Server-side invitation-code validation.
- Expiry and rate limiting.
- Audit log.
- Watch/proposal-only default for customer test tenants.
- Separate admin switch for XCP.

## Stop Conditions

Do not deploy `test.xlooop.com` or send the `xlooop-test.pages.dev` preview to an external tester if any of these are missing:

- Cloudflare Access application and policy evidence.
- Tenant entitlement proof.
- Customer-safe export scan.
- Authority/consent status for the dataset.
- Operator mode defaulting to Watch/proposal-only.
- Public claim posture blocking production SaaS and validated ROI claims.

## References

- Cloudflare Pages Direct Upload with CI: https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/
- Wrangler Pages deploy command: https://developers.cloudflare.com/workers/wrangler/commands/pages/
- Cloudflare Access policies: https://developers.cloudflare.com/cloudflare-one/policies/access/
