// template-policy-methods.ts · WorkersDalAdapter method installer for the
// customer-safe template/policy projection registry.

import type { DalAdapter } from './DalAdapter';
import {
  createTemplateAdminApprovalRow,
  createTenantLearningPromotionRow,
  createUserLearningSignalRow,
  getEffectivePersonalizationProfileRow,
  listEffectiveTemplateSnapshotsRow,
  resolveEffectiveTemplatesRow,
} from './template-policy-store';
import type { Sql } from '../db/client';

export type TemplatePolicyDalMethods = Pick<
  DalAdapter,
  | 'listEffectiveTemplateSnapshots'
  | 'resolveEffectiveTemplates'
  | 'createTemplateAdminApproval'
  | 'getEffectivePersonalizationProfile'
  | 'createUserLearningSignal'
  | 'createTenantLearningPromotion'
>;

type AdapterCtor = { prototype: object };
type AdapterThis = { sql: Sql };
const sqlOf = (value: unknown): Sql => (value as AdapterThis).sql;

export function applyTemplatePolicyMethods(adapter: AdapterCtor): void {
  const methods: TemplatePolicyDalMethods = {
    listEffectiveTemplateSnapshots(workspaceId, opts) {
      return listEffectiveTemplateSnapshotsRow(sqlOf(this), workspaceId, opts);
    },
    resolveEffectiveTemplates(workspaceId, actorUserId, opts) {
      return resolveEffectiveTemplatesRow(sqlOf(this), workspaceId, actorUserId, opts);
    },
    createTemplateAdminApproval(workspaceId, actorUserId, input) {
      return createTemplateAdminApprovalRow(sqlOf(this), workspaceId, actorUserId, input);
    },
    getEffectivePersonalizationProfile(workspaceId, actorUserId, roleKey) {
      return getEffectivePersonalizationProfileRow(sqlOf(this), workspaceId, actorUserId, roleKey);
    },
    createUserLearningSignal(workspaceId, actorUserId, input) {
      return createUserLearningSignalRow(sqlOf(this), workspaceId, actorUserId, input);
    },
    createTenantLearningPromotion(workspaceId, actorUserId, input) {
      return createTenantLearningPromotionRow(sqlOf(this), workspaceId, actorUserId, input);
    },
  };

  Object.assign(adapter.prototype, methods);
}
