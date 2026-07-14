// operational-spine-methods.ts · WorkersDalAdapter method installer.
//
// Keeps packet/evidence/approval/tool-event/metric-delta delegation out of the
// already-large WorkersDalAdapter class while preserving the DalAdapter surface.

import type { DalAdapter } from './DalAdapter';
import type { WorkspaceId, UserId } from './types';
import {
  createTaskPacketRow,
  listTaskPacketsRow,
  evaluateTaskPacketCompletionRow,
  createEvidenceItemRow,
  listEvidenceItemsRow,
  createApprovalRequestRow,
  decideApprovalRequestRow,
  listApprovalRequestsRow,
  createToolEventRow,
  listToolEventsRow,
  createMetricDeltaRow,
  listMetricDeltasRow,
  executeCustomerDataLifecycleRequestRow,
} from './operational-spine-store';
import type { Sql } from '../db/client';

export type OperationalSpineDalMethods = Pick<
  DalAdapter,
  | 'createTaskPacket'
  | 'listTaskPackets'
  | 'evaluateTaskPacketCompletion'
  | 'createEvidenceItem'
  | 'listEvidenceItems'
  | 'createApprovalRequest'
  | 'decideApprovalRequest'
  | 'listApprovalRequests'
  | 'createToolEvent'
  | 'listToolEvents'
  | 'createMetricDelta'
  | 'listMetricDeltas'
  | 'executeCustomerDataLifecycleRequest'
>;

type AdapterCtor = { prototype: object };
type AdapterThis = { sql: Sql; rlsSql?: Sql };
// RLS defense-in-depth (Plane 1 cutover, 260629): the spine tables are the RLS-protected surface, so
// route their tenant-scoped operations through the restricted, RLS-SUBJECT client (`rlsSql`) when the
// adapter was given one (XLOOOP_RLS_APP_DATABASE_URL set). Falls back to the owner `sql` when absent —
// BYTE-IDENTICAL until the secret is provisioned. The withWorkspaceRlsContext GUC then enforces isolation
// at the DB level as a second layer under the app-level WHERE clauses.
const sqlOf = (value: unknown): Sql => { const a = value as AdapterThis; return a.rlsSql ?? a.sql; };

export function applyOperationalSpineMethods(adapter: AdapterCtor): void {
  const methods: OperationalSpineDalMethods = {
    createTaskPacket(workspaceId, actorUserId, input) {
      return createTaskPacketRow(sqlOf(this), workspaceId, actorUserId, input);
    },
    listTaskPackets(workspaceId, opts) {
      return listTaskPacketsRow(sqlOf(this), workspaceId, opts);
    },
    evaluateTaskPacketCompletion(workspaceId, packetId) {
      return evaluateTaskPacketCompletionRow(sqlOf(this), workspaceId, packetId);
    },
    createEvidenceItem(workspaceId, actorUserId, input) {
      return createEvidenceItemRow(sqlOf(this), workspaceId, actorUserId, input);
    },
    listEvidenceItems(workspaceId, opts) {
      return listEvidenceItemsRow(sqlOf(this), workspaceId, opts);
    },
    createApprovalRequest(workspaceId, actorUserId, input) {
      return createApprovalRequestRow(sqlOf(this), workspaceId, actorUserId, input);
    },
    decideApprovalRequest(workspaceId, approvalId, actorUserId, input) {
      return decideApprovalRequestRow(sqlOf(this), workspaceId, approvalId, actorUserId, input);
    },
    listApprovalRequests(workspaceId, opts) {
      return listApprovalRequestsRow(sqlOf(this), workspaceId, opts);
    },
    createToolEvent(workspaceId, actorUserId, input, opts) {
      return createToolEventRow(sqlOf(this), workspaceId, actorUserId, input, opts);
    },
    listToolEvents(workspaceId, opts) {
      return listToolEventsRow(sqlOf(this), workspaceId, opts);
    },
    createMetricDelta(workspaceId, actorUserId, input) {
      return createMetricDeltaRow(sqlOf(this), workspaceId, actorUserId, input);
    },
    listMetricDeltas(workspaceId, opts) {
      return listMetricDeltasRow(sqlOf(this), workspaceId, opts);
    },
    executeCustomerDataLifecycleRequest(workspaceId, actorUserId, input) {
      return executeCustomerDataLifecycleRequestRow(sqlOf(this), workspaceId, actorUserId, input);
    },
  };

  Object.assign(adapter.prototype, methods);
}
