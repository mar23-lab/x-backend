# AGENTS.md — x-backend Agent-Neutral Capability Contract

**Authority:** ADR-0035 (agent-neutral capability contract). Machine SSOT for cross-repo boundaries:
MB-P `BOUNDARY_MATRIX.yml`.

**First stop for ANY AI agent** — Claude, Codex, Cursor, or other — in this repo. Read before any
action. `CLAUDE.md` carries the same rules; this file is the agent-neutral SSOT.

## What this repo is

A **SHADOW backend** — a provenance-verified, buildable, test-green backend that is **NOT the live
runtime** until an explicitly operator-approved cutover. Xlooop-XCP-demo is the current deployed
authority. This distinction is invisible from code/PR state, and getting it wrong is dangerous — see
rule 1.

## Non-negotiable rules (harm-first — read this section even if you read nothing else)

1. **SHADOW REPO — never deploy, apply a migration to a live DB, mutate production data, alter secrets,
   or flip feature flags.** A non-Claude agent sees a fully buildable backend with wrangler + Neon
   config and could "just deploy" or "run the migration" — which would act on production before the
   sanctioned cutover. All of that is operator-gated.
2. **RLS GRANT-PARITY INVARIANT — the most dangerous silent defect a DB-writing agent can introduce.**
   Any table `GRANT`ed to the `xlooop_app` role MUST also have `ENABLE ROW LEVEL SECURITY` **and** at
   least one row-level policy. A single missing `ENABLE ROW LEVEL SECURITY` on a granted table = silent
   cross-tenant read, with no error and no failing test. When adding/altering a table or a GRANT, verify
   grant-parity. (`folder_snapshots` is the one reasoned exemption — direct reads use the OWNER
   connection.) Keep tenant/workspace binding, RBAC, RLS, audit events, receipts, and idempotency
   **fail-closed**.
3. **Migrations live in `src/workers/db/migrations/` as numbered `NNN_*.sql`** (082+). An agent asked
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

## Local checks

- Run `npm run ci-local` before every commit; `npm run verify:bundle` for bundle-affecting changes.
  (No cloud CI until commercial launch — all checks run locally.)

---
_`CLAUDE.md` holds the same rule set in brief. This AGENTS.md is the agent-neutral SSOT; when the two
ever diverge, AGENTS.md wins._
