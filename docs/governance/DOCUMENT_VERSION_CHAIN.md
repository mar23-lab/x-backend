# Document Version Chain (A-W5) — evidence integrity + versioned artefacts

**Status:** IMPLEMENTED · migration 051 APPLIED to prod (`workers_schema_version` v51, 2026-07-06) ·
build live at `api.xlooop.com`. Frozen by `scripts/verify-document-version-chain.mjs` (ci-local).

> This documents the **shipped in-table model**. It is NOT a separate `document_versions` table. A prior
> handoff prompt proposed one; that would collide on migration 051, create a dead competing model, and fail
> the gate. Do not build it — extend the in-table chain below.

## Why
`evidence_items` pin to a document by `uri` + a nullable `content_hash`, but `documents` themselves carried
no content hash — so evidence could not prove "the exact bytes I cited are still these bytes", and a
re-uploaded document became a NEW unrelated row with no version lineage. The new UI models artefacts as a
**version** with a **restorable predecessor** ("v1 draft → v2 published"). A-W5 adds the backend half.

## Model — three additive columns on `documents`
| Column | Meaning |
|---|---|
| `content_hash TEXT` | SHA-256 (hex) of the document's content bytes — the **immutable version identity**. An `evidence_items.content_hash` is matched against this to prove byte-integrity. |
| `version INTEGER NOT NULL DEFAULT 1` | 1-based version number within a supersedes chain. |
| `supersedes_id TEXT` | the prior version's document `id` (self-referencing chain); `NULL` for a first upload. |

`documents` rows are already **content-immutable** — only `status`/`admissibility` metadata is ever
`UPDATE`d — so `content_hash` is stable for the life of a row. There is no `documents.current_version_id`
pointer: the "latest" version is resolved by query (see below), not a denormalized column that could drift.

Indexes (051): `idx_documents_content_hash (workspace_id, content_hash)` for the byte-integrity lookup +
version-chain walk; `idx_documents_supersedes (supersedes_id) WHERE supersedes_id IS NOT NULL`.

## Write path — who/what created a version (uses A-W4 lineage)
`POST /api/v1/documents` (`src/workers/routes/documents.ts`):
1. Compute `contentHash = sha256Hex(bytes)` (`src/workers/lib/document-store.ts` — `crypto.subtle.digest`).
2. `getLatestDocumentVersionRow(sql, ws, project, filename)` — the "same logical document" = identical
   `filename` within the same `project`. If a prior version exists → new row gets `version = prior.version+1`
   and `supersedes_id = prior.id`; else `version = 1`, `supersedes_id = null`.
3. `insertDocumentRow` writes the full column set (degrade-safe: on a pre-051 "column does not exist" it
   falls back to the legacy INSERT, so ingestion never breaks on a migrate→deploy ordering slip).

The **actor/instrument** that created the version is the A-W4/P6 principal-instrument lineage recorded on the
document-upload `operation_events` row (`authorized_by_user_id` / `instrument_kind` / `authority_source` /
`request_id`, `src/workers/lib/actor-lineage.ts`), NOT duplicated onto the documents row — one lineage SSOT.

## Evidence → version binding
`evidence_items` (`src/workers/dal/operational-spine-store.ts`) carry `uri` + a nullable `content_hash`.
Integrity check: an evidence item's `content_hash` is matched to `documents.content_hash`
(`idx_documents_content_hash`) to answer "which document has exactly these bytes, and at what version". This
binding is **backward-compatible** — legacy evidence with a null `content_hash` keeps its `uri` reference;
version-aware evidence is additive, no forced migration of existing rows.

## Backfill + old-row compatibility
`content_hash` was **backfilled deterministically** for existing rows
(`UPDATE documents SET content_hash = encode(sha256(content),'hex') WHERE content_hash IS NULL`). This is the
one sanctioned backfill in the arc — a version identity is worthless if evidence-referenced docs lack it, and
it changes no user data (pure hash of existing bytes). `version`/`supersedes_id` are **new-writes-only**
(existing rows read `1`/`null`). Reads are degrade-safe: pre-051 rows / pre-051 deploys read `null`/`1`/`null`
and never break.

## Customer-safe redaction
`content_hash`, `version`, `supersedes_id` are non-identifying metadata (a byte hash + integers) — no
principal/PII redaction applies (contrast the A-W4.1 `authorized_by_user_id` redaction, which is separate and
lives on the events read model). Safe on any tenant read surface.

## New-UI artefact mapping (reference-only)
| New-UI artefact field | Backend |
|---|---|
| `ver` | `documents.version` |
| `restorable` | `documents.supersedes_id IS NOT NULL` (a version that supersedes a predecessor is restorable-to) |
| version identity for lineage-by-version | `documents.content_hash` |

## Gate + rollback
- `scripts/verify-document-version-chain.mjs` (ci-local): T1 the three columns exist in migration 051 · T2
  `insertDocumentRow` INSERT column list includes `content_hash, version, supersedes_id` (regex pinned to the
  INSERT list, not RETURNING) · T3 the 051 file content. Adversarially proven (inject→FAIL, restore→PASS).
- **Rollback: forward-only.** Columns are nullable/additive; "rollback" = stop populating (new writes read
  the legacy defaults). No destructive down-migration.

## Not done (tracked, low priority)
- A version-aware evidence-attachment path (evidence that pins `documents.id` + `content_hash` at attach
  time) is designed here but not yet wired on a specific route — legacy `uri`-based evidence still works.
