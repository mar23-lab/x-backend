# Cloudflare Access Evidence Checklist

Attach one evidence row per environment before treating a deployment as customer-visible.

| Evidence | `dev` | `test` | Required before external tester |
|---|---:|---:|---:|
| Cloudflare Pages project exists | required | required | yes |
| Custom domain bound | `dev.xlooop.com` | `test.xlooop.com` | yes |
| Cloudflare Access app exists | required | required | yes |
| Access policy restricts identities | internal owner | named testers | yes |
| Remote Access verifier passes | recommended | `verify-cloudflare-access-remote --env=test` | yes |
| Local `CLOUDFLARE_API_TOKEN` available to operator shell | required | required | yes |
| Local `CLOUDFLARE_ACCOUNT_ID` available to operator shell | required | required | yes |
| Local Pages project env var present | `CLOUDFLARE_PAGES_PROJECT_XLOOOP_DEV` | `CLOUDFLARE_PAGES_PROJECT_XLOOOP_TEST` | yes |
| GitHub Actions posture | `verify:github-actions-disabled` passes | `verify:github-actions-disabled` passes | yes while unpaid/unavailable |
| Local deploy receipt writer | `deploy:cloudflare:dev:local` writes receipt | `deploy:cloudflare:test:local:*` writes receipt | yes |
| Feedback cloud smoke | optional | `verify:feedback-cloud-smoke` passes | yes |
| Closeout retrospective composed | required for deploy changes | `verify:retrospective-closeout-composed` passes | yes |
| Feedback D1 binding exists | `FEEDBACK_DB` -> `xlooop-feedback-dev` | `FEEDBACK_DB` -> `xlooop-feedback-test` | yes |
| Feedback Access flag enabled | `FEEDBACK_REQUIRE_ACCESS=1` | `FEEDBACK_REQUIRE_ACCESS=1` | yes |
| Feedback migration applied | `feedback_annotations` table present | `feedback_annotations` table present | yes |
| Tenant entitlement proof exists | optional | required | yes |
| Customer-safe export manifest approved | no | required | yes |
| Operator mode default checked | owner/operator | Watch/proposal-only | yes |
| XCP second-level entitlement checked | admin only | disabled by default | yes |
| Claim posture checked | internal only | customer-feedback only | yes |

Evidence must include the commit SHA, environment, Cloudflare account/project identifiers, Access app or policy identifiers, tester identity list or group name, tenant id, action mode, and export manifest hash.

Do not paste API tokens, Access JWTs, one-time codes, customer secrets, or raw private data into this file.

## Pages.dev Safe Preview Exception

`xlooop-test.pages.dev` may be deployed before `test.xlooop.com` Cloudflare Access exists only when `data/customer-safe-export-manifest.json` is approved and the generated bundle passes the customer-safe scan.

This exception is not external customer-feedback approval. It is a redacted, watch-only preview boundary. Full persisted feedback testing still requires a Cloudflare Access self-hosted app covering `xlooop-test.pages.dev` while custom-domain DNS is deferred:

- private integrations remain blocked;
- Operator mode remains blocked;
- raw customer files remain unprocessed;
- `FEEDBACK_REQUIRE_ACCESS=1` remains enabled;
- exact ROI, production SaaS, autonomous customer operations, and private-source claims remain blocked;
- `test.xlooop.com` remains blocked until the domain is active in Cloudflare and `verify-cloudflare-access-remote --env=test` passes.

## Required Commands

Use these commands to distinguish CI readiness from cloud readiness:

```bash
npm run verify:github-actions-runner-infra
npm run verify:github-actions-disabled
npm run verify:feedback-d1-cloudflare
npm run verify:feedback-cloud-smoke
npm run verify:retrospective-closeout-composed
npm run verify:cloudflare-access-evidence
npm run provision:cloudflare-pages-access:test
npm run deploy:cloudflare:test:local:feedback
```

If `verify:github-actions-runner-infra` reports `github_actions_job_failed_before_steps`, do not claim GitHub Actions deployment is working. While GitHub Actions is unpaid/unavailable, keep `.github/workflows` empty and use local deploy as the canonical path.
