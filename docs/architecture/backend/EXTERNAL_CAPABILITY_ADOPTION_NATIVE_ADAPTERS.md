# External Capability Adoption And Native Adapter Policy

Xlooop adopts the pipeline, not third-party authority.

The commercial backend path is:

`source file -> sandboxed extraction -> redaction -> ACL filter -> citation/provenance -> tenant memory projection -> packet/evidence/API/MCP`

Third-party tools may enter only through the External Capability Registry. They are disabled by default and must pass benchmark, security, redaction, citation, tenant-isolation, license/SBOM, and rollback gates.

## Adoption Modes

- `external_benchmark`: evaluate outside runtime; no customer influence.
- `canary_only`: advisory detector/probe for controlled validation; no runtime authority.
- `restricted_adapter`: run behind a sandboxed backend adapter and tenant feature flag.
- `native_rebuild`: harvest useful patterns, then reimplement in Xlooop-native schemas and controls.
- `default_runtime`: allowed only after production evidence and owner approval.

## MarkItDown

MarkItDown is the strongest near-term conversion candidate. It should start as a sandboxed restricted adapter for file conversion only.

Allowed lane: tenant-scoped file conversion into source-span-wrapped, redaction-safe normalized text.

Required controls: no network by default, plugins disabled by default, file allowlists, size limits, timeouts, process isolation, redaction, source-span citation, ACL checks, delete/export linkage, and replay from the original artifact.

## Hyper-Extract

Hyper-Extract should not become graph authority. Its useful ideas may be harvested into a native Xlooop typed extraction profile system.

Native Xlooop typed extraction profile outputs must be one of:

- `SourceExtractionCandidate`
- `ExtractionEvidenceRef`
- `GraphSuggestion`
- `EffectiveTemplateSnapshot` metadata

Graph pattern inspiration is allowed only as reviewed architecture input. External graph authority, direct Hyper-Extract MCP customer exposure, persistent upstream graph authority, Obsidian export as customer authority, raw graph export, and private schema exposure are forbidden.

This means Hyper-Extract can improve native graph architecture through schema-quality metrics, source-span confidence patterns, graph-stability heuristics, and structure-catalog ideas, but every accepted idea must be reimplemented under Xlooop tenancy, ACL, evidence, redaction, and audit controls.

## Headroom

Headroom remains a backend-only compression benchmark candidate.

Compression can only be considered when original payload hash, compressed payload hash, reversible replay, post-decompression citation checks, redaction invariants, and answer-equivalence gates are present.

## Impeccable

Impeccable is accepted as a customer-UI quality detector only. It may run as a pinned CLI canary against source text and controlled hosted routes to catch typography drift, layout overflow, brittle motion, generic AI-design tells, and design-system violations.

It is not a product-data API, memory source, graph authority, source writer, customer-session live tool, or governance scorer. Live Mode, Chrome extension usage, and automatic source-writing flows are not approved for production customer sessions. Any finding remains advisory until reviewed against Xlooop design doctrine and tenant-safety gates.

## Decision Bar

Default adoption requires:

- extraction fidelity `>=95%` where extraction applies;
- answer equivalence `>=95%` where compression applies;
- citation/source-span coverage `>=95%`;
- token reduction `>=25%` for compression, target `>=40%`;
- redaction invariant `100%`;
- sensitive leakage `0`;
- tenant-boundary bypass `0`;
- external graph authority `0`;
- replayability `100%`;
- license/security/SBOM pass;
- owner approval and rollback plan.
