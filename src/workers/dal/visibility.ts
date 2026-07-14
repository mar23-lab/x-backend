// visibility.ts · Role → visibility set mapping
//
// Authority: API_CONTRACT_V1.md §Visibility enforcement · AUTH_TENANCY_MODEL.md §RBAC
//
// Pure helper — no I/O, no side effects.

import { Visibility, WorkspaceRole } from './types';

/**
 * Returns the set of visibility values a role is permitted to see.
 *
 * Per AUTH_TENANCY_MODEL.md:
 *   owner    → all 4 visibility levels (including internal_owner_only)
 *   operator → internal_workspace, internal_project, public_safe
 *   viewer   → internal_project, public_safe
 *   client   → public_safe only
 */
export function visibilityForRole(role: WorkspaceRole): readonly Visibility[] {
  switch (role) {
    case 'owner':
      return ['internal_workspace', 'internal_project', 'internal_owner_only', 'public_safe'];
    case 'operator':
      return ['internal_workspace', 'internal_project', 'public_safe'];
    case 'viewer':
      return ['internal_project', 'public_safe'];
    case 'client':
      return ['public_safe'];
    default: {
      // Exhaustiveness guard for future role additions.
      const _exhaustive: never = role;
      void _exhaustive;
      return ['public_safe'];
    }
  }
}

/**
 * Maps Clerk's org_role string to Xlooop's WorkspaceRole.
 * Day 1 simplification per AUTH_TENANCY_MODEL.md §3.
 */
export function clerkRoleToWorkspaceRole(clerkOrgRole: string | undefined | null): WorkspaceRole {
  if (!clerkOrgRole) return 'viewer';
  if (clerkOrgRole === 'org:admin') return 'operator'; // Day 1: admin = operator (owner promotion is manual)
  if (clerkOrgRole === 'org:member') return 'viewer';
  return 'viewer'; // unknown role → safest default
}
