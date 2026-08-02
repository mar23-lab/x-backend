// plan-entities-facade.ts · G1/G2 (260711) · sub-facade the adapter COMPOSES (FROZEN_DECOMPOSE rule:
// new DAL surface must NOT bloat WorkersDalAdapter.ts). All SQL lives in ./plan-store + ./source-store;
// these are thin delegations bound to the adapter's sql handle. Mirrors ./session-preferences-facade.

import type { Sql } from '../db/client';
import type {
  UserId,
  WorkspaceId,
  PlanEntity,
  PlanEntityAuthorityReceipt,
  PlanEntityCreateInput,
  PlanEntityListContext,
  PlanEntityMutationIdempotencyInput,
  PlanEntityPatch,
  SourceReadPolicy,
} from './types';
import type { SourceReadPolicyWriteReceipt } from './source-store';
import { listPlanEntitiesRow, getPlanEntityRow } from './plan-store';
import {
  commandTargetFromEntity,
  createPlanEntityWithAuthorityRow,
  deletePlanEntityWithAuthorityRow,
  updatePlanEntityWithAuthorityRow,
} from './plan-command-operations';
import { setUserSourceReadPolicyRow } from './source-store';

export interface PlanEntitiesFacade {
  createPlanEntity(
    input: PlanEntityCreateInput,
    actorUserId: UserId,
    idempotency: PlanEntityMutationIdempotencyInput,
  ): Promise<PlanEntityAuthorityReceipt>;
  listPlanEntities(scopeId: string, ctx: PlanEntityListContext): Promise<PlanEntity[]>;
  getPlanEntity(id: string, workspaceId: WorkspaceId): Promise<PlanEntity | null>;
  updatePlanEntity(
    target: PlanEntity,
    patch: PlanEntityPatch,
    actorUserId: UserId,
    idempotency: PlanEntityMutationIdempotencyInput,
  ): Promise<PlanEntityAuthorityReceipt>;
  softDeletePlanEntity(
    target: PlanEntity,
    actorUserId: UserId,
    idempotency: PlanEntityMutationIdempotencyInput,
  ): Promise<PlanEntityAuthorityReceipt>;
  setUserSourceReadPolicy(userId: UserId, id: string, readPolicy: SourceReadPolicy, workspaceId?: WorkspaceId | null): Promise<SourceReadPolicyWriteReceipt>;
}

export function makePlanEntitiesFacade(getSql: () => Sql): PlanEntitiesFacade {
  return {
    createPlanEntity: (input, actorUserId, idempotency) =>
      createPlanEntityWithAuthorityRow(getSql(), input, actorUserId, idempotency),
    listPlanEntities: (scopeId, ctx) => listPlanEntitiesRow(getSql(), scopeId, ctx),
    getPlanEntity: (id, workspaceId) => getPlanEntityRow(getSql(), id, workspaceId),
    updatePlanEntity: (target, patch, actorUserId, idempotency) =>
      updatePlanEntityWithAuthorityRow(getSql(), commandTargetFromEntity(target), patch, actorUserId, idempotency),
    softDeletePlanEntity: (target, actorUserId, idempotency) =>
      deletePlanEntityWithAuthorityRow(getSql(), commandTargetFromEntity(target), actorUserId, idempotency),
    setUserSourceReadPolicy: (userId, id, readPolicy, workspaceId) => setUserSourceReadPolicyRow(getSql(), userId, id, readPolicy, workspaceId),
  };
}
