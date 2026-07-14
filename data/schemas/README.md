# data/schemas — JSON Schema contracts for data projections

Round 13 R13.1 (2026-05-20).

This directory holds the load-bearing schemas the runtime + build-time
validators check before any data projection is consumed. Schemas pin
the public shape of what flows from the producer side (MB-P generators
+ Xlooop generator scripts) to the UI runtime.

## Why

Operator directive after Round 12 R12.30 architecture critique:

> make the serialisation stable to what and how flows to the ui from
> backend

The R12.30 critique pillar #6 (serialization stability) called out that
producer outputs had no formal contract — readers had to crash to
discover field renames. R13.1 establishes the contract; R13.2 enforces
it at build time; R13.3 validates at runtime; R13.4 makes producers
emit a `_meta` envelope so drift is observable.

## Schemas

| schema file | data file | role |
|---|---|---|
| `operations-live-stream.v1.schema.json` | `data/operations-live-stream.json` | per-row events stream consumed by InlineEventsBoard + LiveStreamRailV3 |
| `document-context-read-model.v1.schema.json` | `data/document-context-read-model.json` | document-anchored context for the doc-context surface |
| `mbp-operations-projection.v1.schema.json` | `data/mbp-operations-projection.json` | MB-P-owned read-model snapshot that backs the operations cockpit |

## `_meta` envelope (target shape · R13.4)

```json
{
  "_meta": {
    "schema": "operations-live-stream.v1",
    "generated_at": "2026-05-20T04:22:08.428Z",
    "producer": "scripts/generate-operations-live-stream.mjs",
    "git_sha": "<commit sha when safe, or empty string for tracked freshness snapshots>"
  },
  ...
}
```

R13.1 schemas accept BOTH the legacy top-level (`schema_version` +
`generated_at`) AND the new `_meta` envelope. R13.4 will inject `_meta`
into producer outputs; R13.5+ may tighten the schema to make `_meta`
required.

## How the validator picks a schema

`scripts/verify-data-schemas.mjs` matches by file path:

| data file | schema |
|---|---|
| `data/operations-live-stream.json` | `data/schemas/operations-live-stream.v1.schema.json` |
| `data/document-context-read-model.json` | `data/schemas/document-context-read-model.v1.schema.json` |
| `data/mbp-operations-projection.json` | `data/schemas/mbp-operations-projection.v1.schema.json` |

When `_meta.schema` is present, the validator also verifies that
declared schema matches the resolved one.

## Versioning rules

- One schema file per major version. `v1` is the current contract.
- Breaking changes ship as `*.v2.schema.json` alongside v1; readers
  may consume either until producers cut over.
- Non-breaking additions extend the v1 file. `additionalProperties:
  true` keeps forward-compat.

## Draft

All schemas use **JSON Schema draft-07** (`$schema:
http://json-schema.org/draft-07/schema#`). Chosen for broad tool
support without pulling in `ajv` as a runtime dep — the in-tree
validator at `scripts/verify-data-schemas.mjs` implements the
draft-07 subset we actually need (type, required, properties,
additionalProperties, items, enum, pattern, const).
