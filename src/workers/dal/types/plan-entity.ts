// types/plan-entity.ts · G1 (260711) · customer plan entities (goal/milestone/todo/intent).
//
// Authority: src/workers/db/migrations/066_plan_entities.sql · BACKEND-CONVERGENCE-BUILDLIST-260711 §G1.
//
// One customer-scoped table backs the whole plan facade (`/plan/:scopeId`, `/plan/entity`,
// `/plan/entity/:id`). Workspace-scoped, member-writable (role != 'client'), NO spine action.

import type { UserId, WorkspaceId } from './identity';

export type PlanEntityId = string; // 'ple_<nanoid>'

export type PlanEntityKind = 'goal' | 'milestone' | 'todo' | 'intent';

// Mirrors a row from the `plan_entities` table.
export interface PlanEntity {
  id: PlanEntityId;
  workspace_id: WorkspaceId;
  scope_id: string | null;
  scope_type: string | null;
  parent_id: PlanEntityId | null;
  kind: PlanEntityKind | null;
  title: string;
  summary: string | null;
  status: string;
  position: number;
  target_date: string | null; // ISO date (DATE column)
  derived_from: string | null;
  promoted_to_intent_id: string | null;
  created_by: UserId | null;
  updated_by: UserId | null;
  created_at: string;
  updated_at: string;
}

// Create input — the DAL fills in id/position/timestamps; workspace_id comes from the auth context.
export interface PlanEntityCreateInput {
  workspace_id: WorkspaceId;
  scope_id?: string | null;
  scope_type?: string | null;
  parent_id?: PlanEntityId | null;
  kind: PlanEntityKind;
  title: string;
  summary?: string | null;
  target_date?: string | null;
}

// Patch shape for PATCH /plan/entity/:id. `position` re-packs siblings sharing parent_id.
export interface PlanEntityPatch {
  title?: string;
  status?: string;
  position?: number;
  parent_id?: PlanEntityId | null;
}

// Read context for the workspace-scoped list (mirrors the members.ts fail-closed tenancy).
export interface PlanEntityListContext {
  workspaceId: WorkspaceId;
}
