# ADR-V3-020 · Real Marat session ingest · MB-P → evidence.db

**Status:** Accepted 2026-05-07 · Sprint 7
**Date:** 2026-05-07
**Decision-makers:** Marat
**Cross-link:** [ADR-V3-015](ADR-V3-015-cross-repo-http-boundary.md), [ADR-V3-018](ADR-V3-018-skills-bridge-over-http.md), [ADR-V3-019](ADR-V3-019-http-hmac-replay-cors-log.md), Plan v3 §V Confidentiality Boundary, Plan v3.5 Sprint 7

## Context

ADR-V3-015 noted that engine-mode bundles (`?source=engine`) were populated only by manually-seeded SQLite fixtures (the `B-260505-A/B/C` rows from M8 review). For the data-moat narrative in Plan v3 §M to hold, real Marat-as-system work needs to flow into `~/.xcp-demo/evidence.db` so the demo's substrate widgets render actual session evidence, not fixtures.

Two paths to wire it:
1. **Push from MB-P:** MB-P closing-skill emits JSONL after each session, an ingest CLI consumes it, writes to evidence.db
2. **Pull from xcp-engine:** xcp-engine reads MB-P's git log directly via filesystem path

Path 1 wins because:
- Decouples engine from MB-P internals (engine never reads MB-P paths)
- Sanitisation gate runs at ingest time · forbidden tokens block before they hit evidence.db
- JSONL is operator-readable and auditable
- Manual run + cron + closing-skill hook are all interchangeable

## Decision

### Ingest CLI · `python3 -m services.ingest`

Lives at `xcp-platform/packages/xcp-engine/services/ingest/`. Stdlib only. Reads JSONL from `--evidence <path>` or stdin (`--evidence -`), validates schema + sanitisation, persists to evidence.db.

**JSONL row schema:**

| Field | Type | Required | Default |
|---|---|---|---|
| `bundle_id` | str | yes | — |
| `kind` | str | yes | (free-form: 'document', 'log', 'screenshot', 'link', etc.) |
| `title` | str | yes | — |
| `content_hash` | str | yes | — |
| `summary` | str | yes | — |
| `visibility` | str | no | `'agency-visible'` |
| `workspace_id` | str | no | null |
| `project_id` | str | no | null |
| `actor_id` | str | no | `'mb-p-ingest'` |

### Sanitisation gate

Before any persistence, scan `title || summary` (case-insensitive) for forbidden tokens:

```python
SANITIZE_FORBIDDEN_TOKENS = (
    "MARAT_PRIVATE",
    "MARAT-PRIVATE",
    "@marat",
    "PLO_",
    "ikigai-",
    "cv-private",
    "session-vault",
    "DO_NOT_PROMOTE",
)
```

**Behaviour:** if ANY row contains a forbidden token, reject the WHOLE file. Exit code 2. Nothing persisted. Operator must clean the source and retry.

This matches the spirit of the `xcp-mb-p-export-to-xcp.mjs` denylist (Plan v3 §B item from W2 sanitiser script).

### Two-pass validation

- Pass 1: parse all rows, validate required fields, run sanitisation against each
- Pass 2: only on full-pass success, insert all into evidence.db

Atomic semantics: either the whole file lands or none of it does. Partial states never appear in the chain.

### Workspace toggle in demo

Demo's Substrate widget gains `?workspace=<id>` URL param (defaults to `demo-ws`). When set to `mb-p`, the substrate widgets render real session bundles ingested via this CLI.

Example URL after ingesting a session JSONL with `workspace_id: "mb-p"`:
```
http://localhost:8768/v3/?source=engine&hmac=dev-secret-do-not-use-in-prod&workspace=mb-p
```

### Operator workflow

**Manual run (today):**
```sh
cd /Users/maratbasyrov/WIP/xcp-platform/packages/xcp-engine
PYTHONPATH=. python3 -m services.ingest --evidence ~/Documents/sprint-7-session.jsonl
```

**Closing-skill hook (future · MB-P):** post-commit closing skill in MB-P writes a JSONL of the session's outputs to `~/.xcp-demo/inbox/<timestamp>.jsonl`, then calls the ingest CLI. Implementation lives MB-P-side (read-only from this session's role classifier · operator installs).

**Cron / launchd (future):** watch `~/.xcp-demo/inbox/*.jsonl`, ingest each, archive on success.

### What doesn't enter the chain

- `attestation_blocks` are NOT written via ingest (those come from `LLMBridge.dispatch` only · keep the chain trustworthy by not allowing post-hoc back-fill)
- `events` table is NOT written (operator hooks emit events directly to the bus; ingest is for evidence artefacts only)
- `gate_passes` and `signoffs` are NOT written via ingest (these come from the policy gate at run-time)

Ingest is **artefacts only**.

## Consequences

**Positive:**
- Real Marat session evidence flows into `evidence.db` with one CLI call
- Sanitisation gate catches accidental private-content promotion at the boundary
- Ingest is atomic and auditable (CLI prints "✓ ingested N artefact rows")
- Demo at `?workspace=mb-p` shows real work without rebuilding · just URL change
- Closing-skill hook becomes a one-line addition in MB-P (not modified here)

**Negative:**
- Forbidden-token list is static and conservative · false positives possible (e.g. legitimate `@marat` mention in a public artefact). Operator must rephrase or override (no override mechanism today by design).
- Schema validation is field-presence only · richer constraints (e.g. enum `kind`) deferred
- Two-pass means large ingests buffer the whole file in memory · fine for session-sized JSONLs (KBs); not for streaming
- No dedup yet · running the same JSONL twice creates duplicate rows (artefact_id is hashed from content though, so SQLite UNIQUE constraint catches exact dups)

**Out of scope:**
- MB-P side closing-skill hook implementation (operator territory · separate ADR if needed)
- Cron/launchd watcher (Sprint 8 pre-pilot prep)
- Encryption of JSONL at rest (operator's filesystem responsibility)
- Distributed ingest across machines (single-host pilot scope)

## Verification

Spec-first per ADR-V3-011 §1:

1. **Failing test FIRST:** `services/ingest/test_ingest.py` (7 tests) · all FAIL on first run because `services.ingest.cli` module doesn't exist
2. **Implementation:** `services/ingest/cli.py` + `__init__.py` + `__main__.py`
3. **All 7 tests PASS** after implementation
4. **Live verification:**
   - Sample JSONL at `/tmp/mb-p-session-sample.jsonl` (5 rows · session-sprint6 + session-audit)
   - `python3 -m services.ingest --evidence /tmp/mb-p-session-sample.jsonl` → "✓ ingested 5 artefact rows"
   - `curl /api/v1/bundles?workspace_id=mb-p` → 2 bundles visible
   - Demo at `?source=engine&workspace=mb-p` renders the real session bundles

## Operational notes

**Sample MB-P session JSONL** (operator-ready template at `v3/project/v3/data/mb-p-session-template.jsonl`):

```jsonl
{"bundle_id":"session-2026-05-07","kind":"document","title":"Sprint 6 closure","content_hash":"sha256:51e8dae","summary":"HMAC + replay shipped","visibility":"client-visible","workspace_id":"mb-p","project_id":"MB-P","actor_id":"marat"}
```

**Verify ingest before the demo loads:**
```sh
python3 -m services.ingest --evidence ./session.jsonl
curl -s "http://localhost:8769/api/v1/bundles?workspace_id=mb-p" | python3 -m json.tool
```

## Open questions (Sprint 8+)

- MB-P closing-skill hook · operator-installed · template lives where?
- Inbox watcher · launchd plist · log rotation
- Ingest dedup heuristic when content_hash differs but title/bundle match
- Forbidden-token list extension as MB-P sanitiser evolves
