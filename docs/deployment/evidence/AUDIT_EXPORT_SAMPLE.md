# Audit-trail export — format sample (SYNTHETIC)

**Purpose.** Show an enterprise security team / external auditor exactly what Xlooop's
governance audit-trail export looks like, without exposing any real customer data. The two
sample files in this directory are generated from the **production serializer**
(`src/workers/lib/audit-export.ts`, the same code path `GET /api/v1/audit-log?format=…`
streams), so the column order, RFC-4180 quoting, and JSONL key order are byte-identical to a
real export. Only the **row values are synthetic** (every id ends in `_SYNTHETIC` / `_DEMO`).

| File | Format | Notes |
|------|--------|-------|
| [`audit-export-sample.csv`](audit-export-sample.csv) | RFC-4180 CSV | CRLF line endings; header always emitted |
| [`audit-export-sample.jsonl`](audit-export-sample.jsonl) | JSONL | one compact object per line |

## Frozen column order (append-only)

`AUDIT_EXPORT_COLUMNS` is a frozen contract — never reordered or removed, so a downstream SIEM
loader can pin positions across releases:

```
occurred_at, actor_user_id, action, target_type, target_id, workspace_id, reason, causation_id
```

## What the sample rows demonstrate

1. **`member_role_change`** — an audited role grant (owner-only editor, Wave A-W2f).
2. **`operating_mode_change`** — the Wave B audit action, written in the same transaction as the
   `user_session_preferences` UPSERT (`session-preferences-store.ts`).
3. **`sd_recommendation_accept`** — a `reason` containing a comma (`… 3 goals, 1 roadmap`) →
   RFC-4180 quotes the whole field; and a populated `causation_id`.

Row 1 & 2 also show a **null `causation_id`**: empty string in CSV, literal `null` in JSONL.

## Producing a REAL export (operator, against prod)

The export is an authenticated operator read — an agent has no admin token, so a real export is
operator-run:

```bash
# CSV (downloads audit-log.csv)
curl -sS 'https://app.xlooop.com/api/v1/audit-log?format=csv' \
  -H "Authorization: Bearer <operator-JWT>" -o audit-log.csv

# JSONL
curl -sS 'https://app.xlooop.com/api/v1/audit-log?format=jsonl' \
  -H "Authorization: Bearer <operator-JWT>" -o audit-log.jsonl
```

The endpoint returns the caller's workspace-scoped trail only (tenant isolation is enforced
server-side); `?format` defaults to paginated JSON when omitted.

## Regenerating this sample

```bash
npx esbuild src/workers/lib/audit-export.ts --bundle --format=esm --platform=node --outfile=/tmp/ae.mjs
# then import { auditToCsv, auditToJsonl } from /tmp/ae.mjs over the synthetic rows above
```

## Cross-references

- Serializer + frozen columns: `src/workers/lib/audit-export.ts`
- Format contract tests: `src/workers/__tests__/audit-export.test.ts`
- Route wiring: `src/workers/routes/workspaces.ts` (`GET /audit-log`)
- Wave B operating-mode audit: `src/workers/dal/session-preferences-store.ts`
