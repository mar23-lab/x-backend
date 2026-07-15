import { assertWorkspaceScope } from './DalAdapter';
import { randomNanoid } from './shared-helpers';
import { withWorkspaceRlsContext } from './operational-spine-store';
import type { Sql } from '../db/client';
import type { UserId, WorkspaceId } from './types';

export type CurrentWorkParityStatus = 'match' | 'mismatch' | 'client_unavailable' | 'server_unavailable';

export interface CurrentWorkParityObservationInput {
  server_projection_version: number;
  client_projection_version: number;
  server_current_work_version: string;
  client_current_work_version: string;
  parity_status: CurrentWorkParityStatus;
  difference_codes: string[];
  server_state_sha256: string | null;
  client_state_sha256: string | null;
  server_item_count: number | null;
  client_item_count: number | null;
}

export async function createCurrentWorkParityObservationRow(
  sql: Sql,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  input: CurrentWorkParityObservationInput,
): Promise<{ id: string; created_at: string }> {
  assertWorkspaceScope(workspaceId);
  const id = `cwp_${randomNanoid()}`;
  const [rows] = await withWorkspaceRlsContext<[Array<{ id: string; created_at: string }>]>(
    sql,
    workspaceId,
    (tx) => [tx/*sql*/`
      INSERT INTO current_work_parity_observations (
        id, workspace_id, actor_user_id,
        server_projection_version, client_projection_version,
        server_current_work_version, client_current_work_version,
        parity_status, difference_codes,
        server_state_sha256, client_state_sha256,
        server_item_count, client_item_count
      ) VALUES (
        ${id}, ${workspaceId}, ${actorUserId},
        ${input.server_projection_version}, ${input.client_projection_version},
        ${input.server_current_work_version}, ${input.client_current_work_version},
        ${input.parity_status}, ${input.difference_codes},
        ${input.server_state_sha256}, ${input.client_state_sha256},
        ${input.server_item_count}, ${input.client_item_count}
      )
      RETURNING id, created_at
    `],
  );
  if (!rows[0]) throw new Error('current-work parity observation was not persisted');
  return rows[0];
}
