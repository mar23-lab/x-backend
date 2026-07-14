// session-preferences-facade.ts · Wave B · sub-facade the adapter COMPOSES (FROZEN_DECOMPOSE rule).
// All SQL lives in ./session-preferences-store; these are thin delegations bound to the adapter's sql handle.

import type { Sql } from '../db/client';
import type { UserId, WorkspaceId } from './types';
import { getOperatingModeRow, setOperatingModeRow, type OperatingMode } from './session-preferences-store';

export interface SessionPreferencesFacade {
  getOperatingMode(userId: UserId, workspaceId: WorkspaceId): Promise<OperatingMode>;
  setOperatingMode(userId: UserId, workspaceId: WorkspaceId, mode: OperatingMode, actorUserId: UserId): Promise<OperatingMode>;
}

export function makeSessionPreferencesFacade(getSql: () => Sql): SessionPreferencesFacade {
  return {
    getOperatingMode: (userId, workspaceId) => getOperatingModeRow(getSql(), userId, workspaceId),
    setOperatingMode: (userId, workspaceId, mode, actorUserId) =>
      setOperatingModeRow(getSql(), userId, workspaceId, mode, actorUserId),
  };
}
