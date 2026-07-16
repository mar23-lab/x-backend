// plan-entities-facade.ts · G1/G2 (260711) · sub-facade the adapter COMPOSES (FROZEN_DECOMPOSE rule:
// new DAL surface must NOT bloat WorkersDalAdapter.ts). All SQL lives in ./plan-store + ./source-store;
// these are thin delegations bound to the adapter's sql handle. Mirrors ./session-preferences-facade.

import type { Sql } from '../db/client';
import type {
  UserId,
  WorkspaceId,
  PlanEntity,
  PlanEntityDeleteReceipt,
  PlanEntityCreateInput,
  PlanEntityListContext,
  PlanEntityPatch,
  SourceReadPolicy,
  UserSourceConnection,
} from './types';
import {
  createPlanEntityRow,
  listPlanEntitiesRow,
  getPlanEntityRow,
  updatePlanEntityRow,
  softDeletePlanEntityRow,
} from './plan-store';
import { setUserSourceReadPolicyRow } from './source-store';

export interface PlanEntitiesFacade {
  createPlanEntity(input: PlanEntityCreateInput, actorUserId: UserId): Promise<PlanEntity>;
  listPlanEntities(scopeId: string, ctx: PlanEntityListContext): Promise<PlanEntity[]>;
  getPlanEntity(id: string, workspaceId: WorkspaceId): Promise<PlanEntity | null>;
  updatePlanEntity(id: string, patch: PlanEntityPatch, actorUserId: UserId): Promise<PlanEntity>;
  softDeletePlanEntity(id: string, actorUserId: UserId): Promise<PlanEntityDeleteReceipt>;
  setUserSourceReadPolicy(userId: UserId, id: string, readPolicy: SourceReadPolicy): Promise<UserSourceConnection>;
}

export function makePlanEntitiesFacade(getSql: () => Sql): PlanEntitiesFacade {
  return {
    createPlanEntity: (input, actorUserId) => createPlanEntityRow(getSql(), input, actorUserId),
    listPlanEntities: (scopeId, ctx) => listPlanEntitiesRow(getSql(), scopeId, ctx),
    getPlanEntity: (id, workspaceId) => getPlanEntityRow(getSql(), id, workspaceId),
    updatePlanEntity: (id, patch, actorUserId) => updatePlanEntityRow(getSql(), id, patch, actorUserId),
    softDeletePlanEntity: (id, actorUserId) => softDeletePlanEntityRow(getSql(), id, actorUserId),
    setUserSourceReadPolicy: (userId, id, readPolicy) => setUserSourceReadPolicyRow(getSql(), userId, id, readPolicy),
  };
}
