# Data retention policy (SSOT · v1 · 2026-07-07)

Formalizes the retention behavior ALREADY ENFORCED in code. Every clause cites its implementation;
nothing here is aspirational. Changes to this policy require a migration/code change + this doc in
the same commit. Companion: [DATA_CLASSIFICATION.md](DATA_CLASSIFICATION.md) ·
[PRODUCTION_DEPENDENCIES.md](../architecture/backend/PRODUCTION_DEPENDENCIES.md).

| Data | Retention | Mechanism (evidence) |
|---|---|---|
| **Audit trail** (`audit_logs`) | **Indefinite, append-only by design** — audit history is never erased, including on customer-data deletion ("does not erase audit trail", API_CONTRACT_V1 §customer-data) | migrations 002/021 (incl. `causation_id` lineage); no UPDATE/DELETE surface exists |
| **Governance/operation events** (`operation_events`) | Content immutable (DB trigger); customer soft-delete via `archived_at` with a **30-day restore window**; hard purge of >30d-archived rows is **flag-gated OFF** (`PURGE_DELETED_ENABLED`, default off) and scoped to `source_tool='xlooop'` only — governance-plane events are NEVER purged | migration 042 (append-only trigger) · crons/purge-deleted.ts · event-store.ts `purgeArchivedXlooopEventsRow` |
| **Customer work artifacts** (roadmap items, prompt tags, source connections) | Soft-delete only (`deleted_at`/`disconnected_at`); restorable; **no hard-delete path exists** (CI gate blocks introducing one) | migration 044 · `verify-no-hard-delete-customer-tables.mjs` (21 protected tables) |
| **API tokens** (`customer_api_tokens`) | Mandatory expiry (`expires_at NOT NULL`); revocation is instant and permanent (`revoked_at`); token material stored as SHA-256 hash only — the raw value is irrecoverable after mint | migration 037 · customer-token-store.ts |
| **Authority consents** | Retained indefinitely incl. after revocation (`revoked_at` recorded, row kept) — consent history is evidence | migration 018 `customer_authority_consents` |
| **Documents** (uploads) | No delete endpoint exists; rows retained | lib/document-store.ts (insert/list/get only) |
| **Sessions** | Held by Clerk (external processor) per Clerk's retention; Xlooop does not persist session records (see gap register) | middleware/auth.ts (stateless JWT verification) |

## Declared gaps (tracked, not hidden)
1. `audit_logs` growth is unbounded — accepted for pilots (append-only guarantee outranks storage
   cost); revisit with an ARCHIVAL (never deletion) tier at scale.
2. `approval_requests` have no archival schedule — same posture.
3. Session-event recording into `audit_logs` (login/logout/revoke) — Wave-2 E2 item.
4. Irreversible storage erasure beyond packet-archive (full crypto-shredding workflow) — explicitly
   deferred per API_CONTRACT_V1 ("a later retention workflow").
