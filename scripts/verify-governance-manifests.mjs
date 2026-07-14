#!/usr/bin/env node
// verify-governance-manifests.mjs · T3/P5 (260710) · the manifest⟷code drift gate.
//
// Three checks, all mechanical:
//   1. PROVIDERS — 3-way id-set equality: connector-registry.ts (CONNECTOR_REGISTRY) ⟷ routes/sources.ts
//      (VALID_PROVIDERS) ⟷ docs/governance/SOURCE_PROVIDER_REGISTRY.yml (providers + connectable_uncatalogued).
//   2. FACT-BUNDLE FIELDS — every field listed in CUSTOMER_FACT_BUNDLE_MANIFEST.yml
//      (source_grounding_fact_fields) exists in the SourceGroundingFact interface (cockpit-chat.ts).
//   3. OBSERVABILITY KINDS — the kinds in METRIC_PRODUCER_CONSUMER_MANIFEST.yml (observability_kinds) ==
//      the ObservabilityKind union in lib/observability.ts (both directions).
// Self-testable: any drift (add/remove/rename on either side) fails with a named check id.

import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');
const failures = [];
const check = (id, ok, details = {}) => { if (!ok) failures.push({ id, ...details }); };

// ── 1. providers, 3-way ───────────────────────────────────────────────────────────────────────────
const registryTs = read('src/workers/lib/connector-registry.ts');
const codeIds = [...registryTs.matchAll(/\{ id: '([a-z_]+)'/g)].map((m) => m[1]);
const sourcesTs = read('src/workers/routes/sources.ts');
const validBlock = sourcesTs.match(/VALID_PROVIDERS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
const validIds = validBlock ? [...validBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
const yamlProviders = read('docs/governance/SOURCE_PROVIDER_REGISTRY.yml');
const yamlIds = [...yamlProviders.matchAll(/^  - id: ([a-z_]+)$/gm)].map((m) => m[1]);
const yamlUncatalogued = [...yamlProviders.matchAll(/^  - ([a-z_]+)$/gm)].map((m) => m[1]);

const setEq = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
check('providers:registry==yaml', setEq(codeIds, yamlIds), { code: codeIds, yaml: yamlIds });
check('providers:valid==registry+uncatalogued', setEq(validIds, [...codeIds, ...yamlUncatalogued]), {
  valid: validIds, expected: [...codeIds, ...yamlUncatalogued],
});

// ── 2. fact-bundle fields exist in the interface ──────────────────────────────────────────────────
const chatTs = read('src/workers/services/cockpit-chat.ts');
const factIface = chatTs.match(/export interface SourceGroundingFact \{([\s\S]*?)\}/)?.[1] ?? '';
const bundleYaml = read('docs/governance/CUSTOMER_FACT_BUNDLE_MANIFEST.yml');
const fieldBlock = bundleYaml.match(/source_grounding_fact_fields:[^\n]*\n([\s\S]*?)\n\n/)?.[1] ?? '';
const manifestFields = [...fieldBlock.matchAll(/^  - ([a-z_]+)$/gm)].map((m) => m[1]);
check('fact-bundle:fields-listed', manifestFields.length >= 8, { found: manifestFields.length });
for (const f of manifestFields) {
  check(`fact-bundle:field-exists:${f}`, new RegExp(`\\b${f}\\??:`).test(factIface), { field: f });
}

// ── 3. observability kinds, both directions ───────────────────────────────────────────────────────
const obsTs = read('src/workers/lib/observability.ts');
const unionBlock = obsTs.match(/export type ObservabilityKind =([\s\S]*?);/)?.[1] ?? '';
const codeKinds = [...unionBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
const metricYaml = read('docs/governance/METRIC_PRODUCER_CONSUMER_MANIFEST.yml');
const kindsBlock = metricYaml.match(/observability_kinds:[^\n]*\n([\s\S]*?)\n\n/)?.[1] ?? '';
const manifestKinds = [...kindsBlock.matchAll(/kind: ([a-z_]+)/g)].map((m) => m[1]);
check('observability:kinds==manifest', setEq(codeKinds, manifestKinds), { code: codeKinds, manifest: manifestKinds });

// ── report ─────────────────────────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(JSON.stringify({ status: 'FAIL', failures }, null, 2));
  console.error(`verify-governance-manifests · FAIL · ${failures.length} drift(s)`);
  process.exit(1);
}
console.log(`verify-governance-manifests · PASS · providers ${codeIds.length}+${yamlUncatalogued.length} · fact-fields ${manifestFields.length} · kinds ${codeKinds.length}`);
