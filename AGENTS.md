# AGENTS.md — x-backend Agent-Neutral Capability Contract

**Authority:** ADR-0035 (agent-neutral capability contract). Machine SSOT for cross-repo boundaries:
MB-P `BOUNDARY_MATRIX.yml`.

**First stop for ANY AI agent** — Claude, Codex, Cursor, or other — in this repo. Read before any
action. `CLAUDE.md` carries the same rules; this file is the agent-neutral SSOT.

## What this repo is

`x-backend` is the production API source authority for Workers routes, DAL, migrations, contracts,
tenant isolation, graph/lineage, receipts, and deployment provenance. A commit in this repository is
not automatically deployed: live `/api/v1/health` is the deployed-runtime truth, and `merged`,
`locally_verified`, `deployed`, and `authoritative` are separate states. `Xlooop-XCP-demo` is
donor-only and must not receive new backend authority.

## Non-negotiable rules (harm-first — read this section even if you read nothing else)

1. **PRODUCTION OPERATIONS ARE OPERATOR-GATED.** Never deploy, apply a live migration, mutate production
   data, alter secrets, flip feature flags, or transfer authority without explicit current approval
   naming the operation and target. A deployment must use the committed candidate, the repository
   preflight, a ratified authority packet, a numeric `schema_head`, an exact 40-character build SHA,
   rollback evidence, and post-deploy health equality. Never bypass `npm run deploy:api` with a raw
   `wrangler deploy`.
2. **RLS GRANT-PARITY INVARIANT — the most dangerous silent defect a DB-writing agent can introduce.**
   Any table `GRANT`ed to the `xlooop_app` role MUST also have `ENABLE ROW LEVEL SECURITY` **and** at
   least one row-level policy. A single missing `ENABLE ROW LEVEL SECURITY` on a granted table = silent
   cross-tenant read, with no error and no failing test. When adding/altering a table or a GRANT, verify
   grant-parity. (`folder_snapshots` is the one reasoned exemption — direct reads use the OWNER
   connection.) Keep tenant/workspace binding, RBAC, RLS, audit events, receipts, and idempotency
   **fail-closed**.
3. **Migrations live in `src/workers/db/migrations/` as numbered `NNN_*.sql`.** An agent asked
   to "add a migration" will plausibly drop a `.sql` in a repo-root `migrations/` — wrong location,
   silently unapplied.
4. **`MIGRATION-PROVENANCE.json` is IMMUTABLE seed evidence.** Never rewrite the original source commit;
   later synchronization requires a NEW receipt. Rewriting it destroys the git-blob-hash record that
   proves this shadow matches its seed.
5. **Never commit filled seed / onboarding files or deploy receipts.** `.seed-customer-*.sql`,
   onboarding outputs, and deploy receipts sit in the working tree looking like ordinary artifacts; an
   agent doing `git add -A` commits real customer data or secrets.
6. **NO frontend implementation here, and no import from `x-ai-front` or legacy frontend roots.** A
   cross-repo source import collapses the repo boundary.
7. **Keep MB-P as governance SSOT, never as a runtime filesystem dependency.** Update the API contract
   whenever a mounted route or envelope changes.
8. **Use an isolated `codex/*` or `claude/*` worktree and a reviewed PR.** Do not direct-push agent
   changes to `main`, and do not merge or mutate Ilmir-owned work.

## Local checks

- Run `npm run ci-local` before every commit; run `npm run verify:bundle` for bundle-affecting
  changes. No GitHub Actions are required while the operator keeps cloud CI disabled.
- Before an approved production deployment, additionally run the migration, RLS grant-parity,
  schema-head, current-SHA, ratified-authority, and rollback checks required by the deployment
  runbook. After deployment, compare the complete health handshake with the committed candidate.

---
_`CLAUDE.md` holds the same rule set in brief. This AGENTS.md is the agent-neutral SSOT; when the two
ever diverge, AGENTS.md wins._
