# x-backend Agent Rules

> **Read [`AGENTS.md`](AGENTS.md) first** — the agent-neutral capability contract (ADR-0035) for ALL
> runtimes. It carries the harm-first rules in full, including the **RLS grant-parity invariant**
> (a table GRANTed to `xlooop_app` without `ENABLE ROW LEVEL SECURITY` = silent cross-tenant read).
> The rules below are the brief form.

This repository is the production API source authority. Deployed provenance remains independent:
code is not live until the operator-approved release preflight succeeds and `/api/v1/health` reports
the exact committed SHA, numeric schema head, contract, environment, authority, and capability
posture.

- Production deploys, data changes, migrations, secrets, flags, and authority transitions require
  explicit current operator approval for the exact operation and target.
- Never bypass `npm run deploy:api` with raw Wrangler or report merged code as deployed.
- Do not add frontend implementation or import from `x-ai-front` or legacy frontend roots.
- Keep tenant/workspace binding, RBAC, RLS, audit events, receipts, and idempotency fail-closed.
- Keep MB-P as governance SSOT, never as a runtime filesystem dependency.
- Update the API contract whenever a mounted route or envelope changes.
- Run `npm run ci-local` before commit and `npm run verify:bundle` for bundle-affecting changes.
- Treat `MIGRATION-PROVENANCE.json` as immutable seed evidence. Later synchronization requires a new
  receipt; do not rewrite the original source commit.
- Treat `Xlooop-XCP-demo` as donor-only; new backend behavior belongs here.
