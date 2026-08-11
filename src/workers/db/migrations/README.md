# Migrations

Sequential SQL migrations for the Neon Postgres backend. Each migration:
- Is **transactional and version-guarded** — a failed migration rolls back and an applied version is not re-run
- Is **additive by default** (per `BACKEND_ROLE_DEFINITION.md §4`) — no `DROP TABLE`/`DROP COLUMN`
- Records its version in `workers_schema_version` for traceability

An existing constraint or index may be replaced only when the product contract
cannot be expressed additively. That exception must prove the exact prior
definition before dropping it, run inside one transaction, provide a
database-backed verifier with negative controls, and receive explicit
environment-scoped owner approval. Migration 101 is the reference pattern: it
replaces global user/provider uniqueness with separate legacy and tenant-scoped
partial uniqueness while preserving all rows and columns.

## Workflow

### Dev branch
```bash
# 1. Create a Neon dev branch
neon branches create --name "migration-<name>" --project-id <id>

# 2. Apply migration
psql $NEON_DEV_BRANCH_URL -f src/workers/db/migrations/<NNN>_<name>.sql

# 3. Verify
psql $NEON_DEV_BRANCH_URL -c "SELECT * FROM workers_schema_version ORDER BY version;"
```

### Production promotion
```bash
# After integration test passes on dev branch:
neon branches merge --id <branch-id>
```

## Migration numbering
- 3-digit zero-padded: `001`, `002`, …, `099`, `100`, …
- One purpose per file (don't mix table creation with data backfill)
- Filename: `<NNN>_<short_description>.sql`

## Authority
- `docs/architecture/backend/DATABASE_SCHEMA_V1.md` — full schema specification
- `docs/architecture/backend/BACKEND_ROLE_DEFINITION.md §4` — migration-only schema changes hard rule
