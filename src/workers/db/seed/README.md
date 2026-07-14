# Seed data

Templates and scripts for one-time customer onboarding into the production database.

## Files

| File | Purpose |
|---|---|
| `customer-template.sql` | Per-customer seed template (workspace + members + project + welcome event). Idempotent. |

## Two ways to onboard a customer

### Option A · Interactive runbook (recommended)

```bash
npm run onboard-customer
```

This walks you through every input interactively, runs the seed against `$DATABASE_URL`, and prints verification queries. Stops on the first error.

### Option B · Manual psql

```bash
# 1. Copy the template (the .seed-* prefix is gitignored)
cp src/workers/db/seed/customer-template.sql .seed-customer-acme.sql

# 2. Edit and substitute the $REPLACE_ME placeholders

# 3. Run
psql "$DATABASE_URL" -f .seed-customer-acme.sql

# 4. Verify
psql "$DATABASE_URL" -c "SELECT id, name, slug FROM workspaces WHERE id = 'org_...';"
```

## What needs to exist before you seed

| Prereq | Where to get it |
|---|---|
| Clerk org for the customer | Clerk Dashboard → Organizations → Create |
| Customer's operator email invited | Clerk Dashboard → Organizations → `<org>` → Members → Invite |
| Customer accepted invite + logged in once | Customer-side action — Clerk creates the user record |
| Owner + operator Clerk user IDs | Clerk Dashboard → Users → click user → copy the `user_…` ID |
| `DATABASE_URL` env var | Set from Neon production connection URL |
| `001_init.sql` migration applied | One-time, see `src/workers/db/migrations/README.md` |

## What seeds DO NOT do

- They do not invite users to Clerk. Use Clerk Dashboard for that.
- They do not write any sensitive secrets. The seed only references Clerk IDs.
- They do not run client-facing notifications. The customer is notified by Clerk's invite email.

## Common mistakes

- **Using the Clerk org slug instead of the org ID** — the workspace `id` must be the immutable `org_<…>` Clerk ID, not the human-readable slug.
- **Forgetting to invite the operator user FIRST in Clerk** — without an invite accepted, there's no Clerk `user_<…>` ID to insert into `workspace_members`.
- **Running the seed before the migration** — `001_init.sql` must run first; if not, `INSERT INTO workspaces` fails because the table doesn't exist.

## Rollback

To remove a customer's seed (test environments only):

```sql
BEGIN;
DELETE FROM sign_offs WHERE workspace_id = '<clerk-org-id>';
DELETE FROM operation_events WHERE workspace_id = '<clerk-org-id>';
DELETE FROM board_cards WHERE workspace_id = '<clerk-org-id>';
DELETE FROM projects WHERE workspace_id = '<clerk-org-id>';
DELETE FROM workspace_members WHERE workspace_id = '<clerk-org-id>';
DELETE FROM operator_sessions WHERE workspace_id = '<clerk-org-id>';
DELETE FROM workspaces WHERE id = '<clerk-org-id>';
COMMIT;
```

**Never run rollback against production data.** Workspaces with real customer events should be archived, not deleted.
