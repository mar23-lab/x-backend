// role-skill-resolver.test.ts · OAR-W2 (260713) · the mission's 8 resolver acceptance tests + positive path.
// Pure-kernel unit tests (no IO). The kernel is deny-wins by fixed precedence; each test pins one gate.

import { describe, it, expect } from 'vitest';
import {
  resolveRoleAndSkills,
  type RoleSkillBinding,
  type RoleSkillResolutionInput,
} from '../lib/role-skill-resolver';

const NOW = new Date('2026-07-13T00:00:00.000Z');

function input(over: Partial<RoleSkillResolutionInput> = {}): RoleSkillResolutionInput {
  return {
    tenant: 'ws_1',
    principal: 'user_1',
    role: 'operator',
    mode: 'operator',
    action: 'packet:create',
    ...over,
  };
}

function binding(over: Partial<RoleSkillBinding> = {}): RoleSkillBinding {
  return {
    role: 'operator',
    skill_key: 'work-item-authoring',
    skill_version: 'v1',
    lifecycle: 'active',
    actions: ['packet:create'],
    allowed_tools: ['doc.write'],
    denied_tools: [],
    source: 'catalog',
    ...over,
  };
}

describe('role-skill-resolver kernel (OAR-W2)', () => {
  // 1. role label alone does not grant skill
  it('resolves the role but grants NO skill when the catalog has no binding for the action', () => {
    const r = resolveRoleAndSkills(input(), [], NOW);
    expect(r.selected_role).toBe('operator'); // role resolved
    expect(r.selected_skills).toEqual([]); // but no skill
    expect(r.verdict).toEqual({ allowed: false, reason: 'skill_not_installed' });
    expect(r.skill_coverage).toBe('no_catalog');
  });

  // 2. missing pack denies
  it('denies when a pack exists for OTHER actions but none installs this action', () => {
    const r = resolveRoleAndSkills(input(), [binding({ actions: ['evidence:submit'] })], NOW);
    expect(r.verdict).toEqual({ allowed: false, reason: 'skill_not_installed' });
    expect(r.skill_coverage).toBe('no_skill_for_action');
  });

  // 3. missing entitlement denies
  it('denies when the entitlement is inactive (most restrictive over a resolvable skill)', () => {
    const r = resolveRoleAndSkills(input({ entitlementActive: false }), [binding()], NOW);
    expect(r.verdict).toEqual({ allowed: false, reason: 'entitlement_missing' });
  });

  // 4. wrong tenant denies
  it('denies on a tenant mismatch (highest precedence)', () => {
    const r = resolveRoleAndSkills(input({ tenantMismatch: true }), [binding()], NOW);
    expect(r.verdict).toEqual({ allowed: false, reason: 'tenant_mismatch' });
  });

  // 5. watch mode denies governed execution
  it('denies governed execution outside operator mode', () => {
    const r = resolveRoleAndSkills(input({ mode: 'watch' }), [binding()], NOW);
    expect(r.verdict).toEqual({ allowed: false, reason: 'mode_requires_operator' });
  });

  // 6. conflicting policy uses the most restrictive result
  it('applies the MOST RESTRICTIVE gate even when a skill would otherwise grant', () => {
    // an active binding grants the skill, but watch mode + a resolvable skill must still deny on mode.
    const r = resolveRoleAndSkills(input({ mode: 'watch' }), [binding()], NOW);
    expect(r.selected_skills).toHaveLength(1); // skill DID resolve
    expect(r.verdict).toEqual({ allowed: false, reason: 'mode_requires_operator' }); // …but deny wins
  });

  // 7. stale pack denies / requires review
  it('denies when only stale (deprecated/blocked) skill versions apply', () => {
    const r = resolveRoleAndSkills(input(), [binding({ lifecycle: 'blocked' })], NOW);
    expect(r.selected_skills).toEqual([]);
    expect(r.verdict).toEqual({ allowed: false, reason: 'skill_stale' });
  });

  // 8. safe explanation contains no internal IDs
  it('safe_explanation exposes no principal / workspace / version / tool internal ids', () => {
    const r = resolveRoleAndSkills(
      input({ principal: 'user_abc123', tenant: 'ws_secret999' }),
      [binding({ skill_version: 'v9-internal', allowed_tools: ['internal.tool.xyz'] })],
      NOW,
    );
    expect(r.safe_explanation).not.toContain('user_abc123');
    expect(r.safe_explanation).not.toContain('ws_secret999');
    expect(r.safe_explanation).not.toContain('v9-internal');
    expect(r.safe_explanation).not.toContain('internal.tool.xyz');
    expect(r.safe_explanation).not.toContain('work-item-authoring'); // skill_key never leaks either
  });

  // positive path — the resolver CAN allow when everything lines up
  it('allows with resolved skills + tools when operator + active binding + same tenant', () => {
    const r = resolveRoleAndSkills(input(), [binding({ denied_tools: ['danger.delete'] })], NOW);
    expect(r.verdict).toEqual({ allowed: true, reason: 'resolved' });
    expect(r.selected_skills).toEqual([{ key: 'work-item-authoring', version: 'v1' }]);
    expect(r.allowed_tools).toEqual(['doc.write']);
    expect(r.denied_tools).toEqual(['danger.delete']);
    expect(r.skill_coverage).toBe('resolved');
    expect(r.expires_at).toBe('2026-07-13T00:15:00.000Z'); // now + 15 min TTL (deterministic)
  });

  it('a denied tool is never also allowed (deny-wins on tool union)', () => {
    const r = resolveRoleAndSkills(input(), [
      binding({ allowed_tools: ['t.a', 't.b'], denied_tools: ['t.b'] }),
    ], NOW);
    expect(r.allowed_tools).toEqual(['t.a']);
    expect(r.denied_tools).toEqual(['t.b']);
  });
});
