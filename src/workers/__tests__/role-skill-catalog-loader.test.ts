// role-skill-catalog-loader.test.ts · AR-2.1 (260713) · proves THE KEYSTONE.
// The single test that matters: with the catalog loaded, a governed write resolves REAL skills
// (skill_coverage='resolved') instead of the empty-floor 'no_catalog' — the metric that was stuck at zero.

import { describe, it, expect } from 'vitest';
import {
  buildCatalogBindings,
  buildRuntimeBindings,
  catalogBindingsIfEnabled,
  CATALOG_MANIFEST_SHA256,
  ARCHETYPE_TO_MEMBERSHIP,
} from '../lib/role-skill-catalog-loader';
import { resolveRoleAndSkills } from '../lib/role-skill-resolver';

const NOW = new Date('2026-07-13T00:00:00Z');

describe('buildCatalogBindings — archetype→membership mapping', () => {
  const b = buildCatalogBindings();

  it('derives one binding per (membership-role × archetype skill)', () => {
    expect(b.length).toBe(14);
    expect(b.every((x) => x.source === 'catalog' && x.lifecycle === 'active')).toBe(true);
  });

  it('maps governed-write skills narrowly and grounded assistance to every workspace role', () => {
    const byRole = b.reduce<Record<string, number>>((a, x) => ((a[x.role] = (a[x.role] || 0) + 1), a), {});
    expect(byRole.owner).toBe(5);
    expect(byRole.operator).toBe(5);
    expect(byRole.collaborator).toBe(2);
    expect(byRole.viewer).toBe(1);
    expect(byRole.client).toBe(1);
    expect(byRole.automation).toBeUndefined();
    expect(ARCHETYPE_TO_MEMBERSHIP['role.operator-lead']).toContain('owner');
  });

  it('keeps the internal automation binding out of the customer-publishable catalog', () => {
    const runtime = buildRuntimeBindings();
    const automation = runtime.filter((x) => x.role === 'automation');
    expect(b.some((x) => x.role === 'automation')).toBe(false);
    expect(automation).toHaveLength(1);
    expect(automation[0].source).toBe('internal-service');
    expect(automation[0].actions).toEqual(['assistant:digest', 'assistant:onboard']);
  });

  it('carries the real actions + tools from the skill entries', () => {
    const shipping = b.find((x) => x.role === 'owner' && x.skill_key === 'skill.software-delivery.governed-shipping');
    expect(shipping).toBeDefined();
    expect(shipping!.actions).toContain('packet:create');
    expect(shipping!.denied_tools).toContain('raw_graph_export'); // internal tool stays denied
  });
});

describe('catalogBindingsIfEnabled — flag gating (shadow-first)', () => {
  it('OFF (flag absent) ⇒ null (caller uses the empty floor — byte-identical)', () => {
    expect(catalogBindingsIfEnabled(undefined)).toBeNull();
    expect(catalogBindingsIfEnabled({})).toBeNull();
    expect(catalogBindingsIfEnabled({ ROLE_SKILL_CATALOG_ENABLED: 'false' })).toBeNull();
  });

  it('ON ⇒ the catalog bindings + the manifest fingerprint', () => {
    const out = catalogBindingsIfEnabled({ ROLE_SKILL_CATALOG_ENABLED: 'true' });
    expect(out).not.toBeNull();
    expect(out!.bindings.length).toBe(15);
    expect(out!.catalog_manifest_sha256).toBe(CATALOG_MANIFEST_SHA256);
    expect(/^[a-f0-9]{64}$/.test(CATALOG_MANIFEST_SHA256)).toBe(true);
  });
});

describe('KEYSTONE — the resolver produces REAL resolution, not no_catalog', () => {
  const input = {
    tenant: 'ws_1', principal: 'usr_1', role: 'owner', mode: 'operator',
    action: 'packet:create', entitlementActive: true, tenantMismatch: false,
  };

  it('empty floor ⇒ no_catalog (the bug this closes)', () => {
    const r = resolveRoleAndSkills(input, [], NOW);
    expect(r.skill_coverage).toBe('no_catalog');
    expect(r.verdict.allowed).toBe(false); // role label alone does not grant a skill
  });

  it('catalog loaded ⇒ resolved + allowed + a selected skill (the fix)', () => {
    const { bindings } = catalogBindingsIfEnabled({ ROLE_SKILL_CATALOG_ENABLED: 'true' })!;
    const r = resolveRoleAndSkills(input, bindings, NOW);
    expect(r.skill_coverage).toBe('resolved');
    expect(r.verdict.allowed).toBe(true);
    expect(r.selected_skills.length).toBeGreaterThan(0);
    expect(r.safe_explanation).not.toContain('usr_1'); // customer-safe: no internal ids leak
  });

  it('a viewer still resolves no skill for a governed write (read-only stays read-only)', () => {
    const { bindings } = catalogBindingsIfEnabled({ ROLE_SKILL_CATALOG_ENABLED: 'true' })!;
    const r = resolveRoleAndSkills({ ...input, role: 'viewer' }, bindings, NOW);
    expect(r.verdict.allowed).toBe(false);
    expect(r.skill_coverage).toBe('no_skill_for_action');
  });

  it('a viewer resolves grounded assistance without gaining governed-write authority', () => {
    const { bindings } = catalogBindingsIfEnabled({ ROLE_SKILL_CATALOG_ENABLED: 'true' })!;
    const r = resolveRoleAndSkills({ ...input, role: 'viewer', mode: 'watch', action: 'assistant:answer', requiresOperatorMode: false }, bindings, NOW);
    expect(r.verdict.allowed).toBe(true);
    expect(r.selected_skills.map((s) => s.key)).toEqual(['skill.workspace-assistant.grounded-assistance']);
  });

  it('an automation principal resolves draft assistance but no approval authority', () => {
    const { bindings } = catalogBindingsIfEnabled({ ROLE_SKILL_CATALOG_ENABLED: 'true' })!;
    const digest = resolveRoleAndSkills({ ...input, role: 'automation', mode: 'plan', action: 'assistant:digest', requiresOperatorMode: false }, bindings, NOW);
    const approve = resolveRoleAndSkills({ ...input, role: 'automation', mode: 'operator', action: 'approval:decide', requiresOperatorMode: false }, bindings, NOW);
    expect(digest.verdict.allowed).toBe(true);
    expect(digest.allowed_tools).toEqual([]);
    expect(approve.verdict.allowed).toBe(false);
  });
});
