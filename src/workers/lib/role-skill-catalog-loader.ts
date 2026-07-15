// role-skill-catalog-loader.ts · AR-2.1 (260713) · THE KEYSTONE — the catalog→binding loader.
//
// The OAR spine audit found the whole role/skill spine was theatre: resolveBindings() in
// role-skill-shadow.ts was hardcoded to the empty floor (ROLE_SKILL_V0_FLOOR = Object.freeze([])), so even
// the full operator activation sequence (apply 070 → sign → deploy → flip resolver) would only stream
// "receipts of nothing" (skill_coverage='no_catalog' forever). This module is the one change that converts
// that into REAL skill resolution: it maps the W3-published customer-safe catalog
// (docs/contracts/role-skill-catalog.json — the single SSOT) into the RoleSkillBinding[] the pure kernel
// (role-skill-resolver.ts) consumes.
//
// PURE + SYNC (the shadow observer calls resolveBindings on the write path; no IO/await). The catalog is a
// committed, immutable-per-version artifact, so the import is inlined by the bundler and the fingerprint is
// a compile-time constant. Flag-gated by ROLE_SKILL_CATALOG_ENABLED (default OFF ⇒ the floor ⇒ byte-identical
// shadow, exactly as today); ON ⇒ the resolver resolves against the real catalog.
//
// v0 MODELING DECISION (explicit + operator-reviewable): the catalog encodes ARCHETYPE roles
// (role.operator-lead …) with a skills[] list, but the resolver's input.role is the MEMBERSHIP role
// (owner/operator/collaborator/viewer/client). The archetype→membership map below is derived faithfully
// from each archetype's own description; viewer/client are intentionally UNMAPPED (read-only → no
// governed-write skill → the kernel honestly reports no_skill_for_action, never a fabricated grant).

import catalog from '../../../docs/contracts/role-skill-catalog.json';
import type { RoleSkillBinding } from './role-skill-resolver';
import { envFlagTrue } from './env-flag';

/** v0 archetype → membership-role mapping. Operator-reviewable; the ONLY assumption in the loader. */
export const ARCHETYPE_TO_MEMBERSHIP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'role.operator-lead': ['owner', 'operator'], // "the default hands-on role for a workspace owner" (its own description)
  'role.delivery-collaborator': ['collaborator'],
  'role.governance-reviewer': ['owner', 'operator'], // approval:decide / signoff:decide authority = owner/operator
  'role.workspace-member': ['owner', 'operator', 'collaborator', 'viewer', 'client'],
  // viewer / client: read-only membership roles — intentionally unmapped (no governed-write skills).
});

/** sha256 of docs/contracts/role-skill-catalog.json — embedded because the sync resolver path cannot await
 *  crypto.subtle. `verify:role-skill-catalog-loader-fresh` (ci-local) re-hashes the file and fails on drift,
 *  so this constant can never silently diverge from the catalog it fingerprints. */
export const CATALOG_MANIFEST_SHA256 = '29b427d4c21d62909aaa64ab4c6aa5add9cd6fbb1477679046974f5db4dfc68a';

interface CatalogEntry {
  key: string;
  category: 'role' | 'skill' | 'pack';
  version: string;
  actions?: string[];
  skills?: string[];
  allowed_tools?: string[];
  denied_tools?: string[];
  requires_approval?: boolean;
}

/** Build RoleSkillBinding[] from the committed catalog (pure; deterministic; no IO). */
export function buildCatalogBindings(): RoleSkillBinding[] {
  const entries = (catalog as { entries: CatalogEntry[] }).entries;
  const skillByKey = new Map(entries.filter((e) => e.category === 'skill').map((e) => [e.key, e]));
  const bindings: RoleSkillBinding[] = [];
  const seen = new Set<string>();
  for (const role of entries.filter((e) => e.category === 'role')) {
    for (const member of ARCHETYPE_TO_MEMBERSHIP[role.key] ?? []) {
      for (const skillRef of role.skills ?? []) {
        const skKey = skillRef.split('@')[0];
        const sk = skillByKey.get(skKey);
        if (!sk) continue; // a role referencing an unpublished skill is skipped (honest, not fabricated)
        const dedupe = `${member}|${sk.key}|${sk.version}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        bindings.push({
          role: member,
          skill_key: sk.key,
          skill_version: sk.version,
          lifecycle: 'active',
          actions: sk.actions ?? [],
          allowed_tools: sk.allowed_tools ?? [],
          denied_tools: sk.denied_tools ?? [],
          requires_approval: sk.requires_approval,
          source: 'catalog',
        });
      }
    }
  }
  return bindings;
}

/** Internal service principals never enter the customer-publishable role catalog. This narrow
 * binding is code-reviewed runtime policy for the xlooop:digest-agent registered in agent-roles.yml. */
export const INTERNAL_SERVICE_BINDINGS: readonly RoleSkillBinding[] = Object.freeze([{
  role: 'automation',
  skill_key: 'skill.workspace-assistant.grounded-assistance',
  skill_version: '1.0.0',
  lifecycle: 'active',
  actions: ['assistant:digest', 'assistant:onboard'],
  allowed_tools: [],
  denied_tools: ['raw_graph_export', 'full_tenant_memory_export', 'secret_access', 'search_all_memory', 'customer_data_export', 'approval_decision'],
  requires_approval: true,
  source: 'internal-service',
}]);

export function buildRuntimeBindings(): RoleSkillBinding[] {
  return [...buildCatalogBindings(), ...INTERNAL_SERVICE_BINDINGS];
}

/** Frozen singleton — the catalog is immutable per version, so the bindings are computed once. */
const CATALOG_BINDINGS: readonly RoleSkillBinding[] = Object.freeze(buildRuntimeBindings());

/** Flag-gated accessor for the shadow resolver. OFF ⇒ null (caller uses the empty floor, byte-identical). */
export function catalogBindingsIfEnabled(env: unknown): { bindings: readonly RoleSkillBinding[]; catalog_manifest_sha256: string } | null {
  if (!envFlagTrue((env as { ROLE_SKILL_CATALOG_ENABLED?: string } | undefined)?.ROLE_SKILL_CATALOG_ENABLED)) return null;
  return { bindings: CATALOG_BINDINGS, catalog_manifest_sha256: CATALOG_MANIFEST_SHA256 };
}
