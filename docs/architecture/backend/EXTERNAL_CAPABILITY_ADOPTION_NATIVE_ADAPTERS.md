# External Capability Adoption And Native Adapter Policy

Xlooop adopts the pipeline, not third-party authority.

The commercial backend path is:

`source file -> sandboxed extraction -> redaction -> ACL filter -> citation/provenance -> tenant memory projection -> packet/evidence/API/MCP`

Third-party tools may enter only through the External Capability Registry. They are disabled by default and must pass benchmark, security, redaction, citation, tenant-isolation, license/SBOM, and rollback gates.

## Adoption Modes

- `external_benchmark`: evaluate outside runtime; no customer influence.
- `canary_only`: advisory detector/probe for controlled validation; no runtime authority.
- `restricted_adapter`: run behind a sandboxed backend adapter, a global kill switch, and an exact
  allowlist of hashed tenant references.
- `native_rebuild`: harvest useful patterns, then reimplement in Xlooop-native schemas and controls.
- `default_runtime`: allowed only after production evidence and owner approval.

## MarkItDown

MarkItDown is the strongest near-term conversion candidate. It starts as a sandboxed restricted adapter for file conversion only.

Allowed lane: tenant-scoped file conversion into source-span-wrapped, redaction-safe normalized text.

Required controls: no network by default, plugins disabled by default, file allowlists, size limits, timeouts, process isolation, redaction, provenance, ACL checks, delete/export linkage, and replay from the original artifact. The current receipt binds the complete normalized output to the original source hash; it does not claim original-file character offsets. Fine-grained source spans remain a separate native parser requirement before source-span-authoritative use.

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

## Runtime Adapter Authority

MarkItDown and Headroom now have a production-shaped, private runtime adapter contract. This is an
implementation of the restricted-adapter lane, not approval to make either capability a default.

```text
tenant API Worker
  -> disabled-by-default global kill switch + hashed tenant allowlist
  -> private Cloudflare service binding
  -> non-public Capability Worker
  -> one-request, no-egress Cloudflare Sandbox
  -> pinned MarkItDown or Headroom package
  -> hashed receipt
  -> native audit/outbox lineage or live-model execution receipt
```

The Capability Worker has no route, `workers.dev` endpoint, or preview URL. Its custom Sandbox class
disables Internet access. Every request uses a new sandbox identity, a fixed environment-cleared
command, bounded payload and execution time, package versions pinned in the container image, and
best-effort destruction after the response. Raw workspace identifiers never cross the service
boundary; the API sends a one-way tenant reference. The image installs only MarkItDown's Office
extras (`docx`, `pptx`, `xlsx`), not its network-capable Azure, speech, YouTube, image, or PDF lanes.
Headroom's tokenizer data is fetched and pinned while building the image, so runtime execution does
not attempt an outbound tokenizer download.

MarkItDown is wired only to Office document conversion. It emits normalized text, a document-level
source reference, source/output hashes, tool version, latency, and replay status. The original bytes
remain in the native tenant document record, while the conversion receipt is written to both the
audit record and projection outbox. Office formats are rejected unless the private binding and flag
are active. Existing native text/PDF behavior remains the baseline even when the flag is enabled:
the current upstream corpus showed PDF cold conversion above the `<3s` target, so the adapter is not
allowed to take over that native lane.

Headroom is wired only as a pre-provider prompt optimization. Obvious credentials are redacted before
the private call, and the adapter hashes that redacted source plus the compressed output. The API
recomputes both hashes and accepts the result only when replay is declared and per-request token
reduction is at least `25%`. The system policy must remain byte-identical, and the operator question,
citations, identifiers, dates, and quoted customer facts must remain present. Any timeout, malformed
receipt, semantic-guard failure, lower reduction, or adapter failure sends the untouched original
in-memory prompt through the same live-provider plan. Compression never creates an assistant answer
and never becomes context or graph authority.

Both production and pilot-shadow flags remain `false`, and their tenant allowlists remain empty.
Deployment order is capability Worker first, then the API binding. A staging enablement additionally
requires an exact owner-approved deployment tuple, the hashed tenant reference in
`EXTERNAL_CAPABILITY_TENANT_REFS`, and a receipt-backed tenant canary. A true global flag with an
empty or non-matching tenant allowlist remains disabled. The 2026-08-12 local Wrangler dry run built the exact
container image successfully. Direct `--network none` execution converted the governed DOCX with
valid source/output hashes and replay status, and compressed a representative governed packet by
`55.2%` while preserving its decision, tenant, citation, owner, due date, and replay hash. The
dependency-surface check found none of the forbidden Azure, speech, YouTube, or PDF packages. Local
latency is diagnostic only because the Cloudflare amd64 image runs through emulation on the arm64
developer host; staging receipts remain the deployment-latency authority.

Hyper-Extract is intentionally absent from this external runtime Worker. Its approved native lane
continues to emit typed extraction candidates and `GraphSuggestion` records only.

Runtime contract verifier: `npm run verify:external-capability-runtime-adapter`.

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
