// domain-archetypes.test.ts — ABS-P3 · the pure archetype registry + skeleton→input mapper.
// Locks: registry is structure-only (slug/label/kind), account-type selection, resolve, and that the
// mapper produces a VALID honest-empty SyntheticDomainCreateInput (≥1 workspace-scoped filter, no content).
import { describe, it, expect } from 'vitest';
import {
  DOMAIN_ARCHETYPES, archetypeKeyForAccountType, resolveArchetype, skeletonToCreateInput,
} from '../services/domain-archetypes';

describe('domain archetypes (ABS-P3)', () => {
  it('every skeleton is STRUCTURE ONLY — slug/label/kind, nothing else', () => {
    for (const arch of Object.values(DOMAIN_ARCHETYPES)) {
      expect(arch.domains.length).toBeGreaterThan(0);
      for (const d of arch.domains) {
        expect(Object.keys(d).sort()).toEqual(['kind', 'label', 'slug']);
        expect(d.slug).toMatch(/^[a-z0-9-]+$/); // valid slug shape
        expect(['life', 'company', 'work', 'custom']).toContain(d.kind);
      }
    }
  });

  it('selects the archetype from account type', () => {
    expect(archetypeKeyForAccountType('personal')).toBe('personal-operating-system');
    expect(archetypeKeyForAccountType('company')).toBe('regulated-smb');
    expect(archetypeKeyForAccountType('both')).toBe('regulated-smb');
    expect(archetypeKeyForAccountType(null)).toBe('regulated-smb');
    expect(archetypeKeyForAccountType(undefined)).toBe('regulated-smb');
  });

  it('resolves known keys and returns null for unknown', () => {
    expect(resolveArchetype('regulated-smb')?.key).toBe('regulated-smb');
    expect(resolveArchetype('personal-operating-system')?.key).toBe('personal-operating-system');
    expect(resolveArchetype('nope')).toBeNull();
    expect(resolveArchetype(null)).toBeNull();
    expect(resolveArchetype(undefined)).toBeNull();
  });

  it('maps a skeleton to a valid honest-empty create input scoped to the workspace', () => {
    const arch = DOMAIN_ARCHETYPES['regulated-smb'];
    const input = skeletonToCreateInput(arch.domains[0]!, 'ws_123', 'user_abc', arch.key);
    expect(input.workspace_id).toBe('ws_123');
    expect(input.slug).toBe(arch.domains[0]!.slug);
    expect(input.label).toBe(arch.domains[0]!.label);
    expect(input.kind).toBe(arch.domains[0]!.kind);
    expect(input.owner_user_id).toBe('user_abc');
    expect(input.visibility).toBe('workspace');
    // binding: exactly one workspace-scoped filter (satisfies validateSyntheticBindingThrowing ≥1 filter)
    expect(input.binding.version).toBe(1);
    expect(input.binding.filters).toHaveLength(1);
    expect(input.binding.filters[0]).toEqual({ type: 'workspace_id_in', values: ['ws_123'] });
    // provenance only — NO goals/metrics/roadmaps in the input
    expect(input.metadata).toEqual({ scaffolded_by: 'domain-archetype-scaffold', archetype: 'regulated-smb' });
    expect(input).not.toHaveProperty('goals');
    expect(input).not.toHaveProperty('metrics');
    expect(JSON.stringify(input)).not.toMatch(/goal_count|has_roadmap|target_value|review_due/);
  });
});
