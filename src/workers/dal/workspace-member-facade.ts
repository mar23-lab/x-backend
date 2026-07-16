// workspace-member-facade.ts · A sub-facade the adapter COMPOSES (not inlines).
//
// Per the FROZEN_DECOMPOSE rule on WorkersDalAdapter.ts (scripts/verify-workspace-
// component-size.mjs, S-R1 260629): the root adapter's size is frozen — new DAL surface
// must live in a *-store PLUS a sub-facade module the adapter composes, never as new
// methods on the frozen root file. This module is that sub-facade for workspace-member
// operations. All SQL lives in ./workspace-member-store; these are thin delegations bound
// to the adapter's live sql handle.

import type { Sql } from '../db/client';
import type { UserId, WorkspaceId, WorkspaceMember, WorkspaceMemberRole, WorkspaceMemberRoleMutationReceipt, WorkspaceMemberRemovalReceipt } from './types';
import { listWorkspaceMembersRow, listWorkspaceMembersForWorkspacesRow, setWorkspaceMemberRoleRow, removeWorkspaceMemberRow, userCanScopeWorkspaceRow, userOwnsWorkspaceRow } from './workspace-member-store';

export interface WorkspaceMemberFacade {
  listWorkspaceMembers(workspaceId: WorkspaceId): Promise<WorkspaceMember[]>;
  // BATCH roster read (N+1 fix): members for many workspaces in one ownership-scoped query, grouped by id.
  listWorkspaceMembersForWorkspaces(
    workspaceIds: WorkspaceId[],
    ownerUserIds: UserId[],
    currentWorkspaceId: WorkspaceId | null,
  ): Promise<Record<string, WorkspaceMember[]>>;
  setWorkspaceMemberRole(
    workspaceId: WorkspaceId,
    targetUserId: UserId,
    role: WorkspaceMemberRole,
    actorUserId: UserId,
  ): Promise<WorkspaceMemberRoleMutationReceipt>;
  // A1 · SOFT-remove a member (owner-only at the route; last-owner + self guards in the store).
  removeWorkspaceMember(
    workspaceId: WorkspaceId,
    targetUserId: UserId,
    actorUserId: UserId,
  ): Promise<WorkspaceMemberRemovalReceipt>;
  // JA · authorization read: may this user scope a read to this workspace? (owner OR active member)
  userCanScopeWorkspace(userId: UserId, workspaceId: WorkspaceId): Promise<boolean>;
  // JB · authorization for WRITES: does this user OWN this workspace? (owner_user_id only — stricter)
  userOwnsWorkspace(userId: UserId, workspaceId: WorkspaceId): Promise<boolean>;
}

// getSql is a thunk so the facade always reads the adapter's current sql handle.
export function makeWorkspaceMemberFacade(getSql: () => Sql): WorkspaceMemberFacade {
  return {
    listWorkspaceMembers: (workspaceId) => listWorkspaceMembersRow(getSql(), workspaceId),
    listWorkspaceMembersForWorkspaces: (workspaceIds, ownerUserIds, currentWorkspaceId) =>
      listWorkspaceMembersForWorkspacesRow(getSql(), workspaceIds, ownerUserIds, currentWorkspaceId),
    setWorkspaceMemberRole: (workspaceId, targetUserId, role, actorUserId) =>
      setWorkspaceMemberRoleRow(getSql(), workspaceId, targetUserId, role, actorUserId),
    removeWorkspaceMember: (workspaceId, targetUserId, actorUserId) =>
      removeWorkspaceMemberRow(getSql(), workspaceId, targetUserId, actorUserId),
    userCanScopeWorkspace: (userId, workspaceId) =>
      userCanScopeWorkspaceRow(getSql(), userId, workspaceId),
    userOwnsWorkspace: (userId, workspaceId) =>
      userOwnsWorkspaceRow(getSql(), userId, workspaceId),
  };
}
