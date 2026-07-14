// tools/event-list.ts · xlooop.event.list
//
// Read recent events for a workspace, optionally filtered by project,
// status, visibility, or actor. Pagination via opaque cursor.

import { apiRequest } from '../api-client.js';
import type { EventListResponse } from '../types.js';

export const eventListDefinition = {
  name: 'xlooop.event.list',
  description:
    'Read recent operation events for a workspace. Used to surface live state to an MCP client. ' +
    'Pass `cursor` from a previous response to paginate. Default page size = 100.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string', description: 'Source workspace id' },
      project_id: { type: 'string', description: 'Optional filter to a single project' },
      status: { type: 'string', description: 'Optional status filter' },
      actor: { type: 'string', description: 'Optional actor filter (e.g. "claude-session-*")' },
      limit: { type: 'integer', description: 'Page size (1-200, default 100)', minimum: 1, maximum: 200 },
      cursor: { type: 'string', description: 'Pagination cursor from prior call' },
    },
    required: ['workspace_id'],
    additionalProperties: false,
  },
} as const;

export async function eventList(args: {
  workspace_id: string;
  project_id?: string;
  status?: string;
  actor?: string;
  limit?: number;
  cursor?: string;
}): Promise<EventListResponse> {
  return apiRequest<EventListResponse>(`/api/v1/events`, {
    method: 'GET',
    query: {
      workspace_id: args.workspace_id,
      project_id: args.project_id,
      status: args.status,
      actor: args.actor,
      limit: args.limit ?? 100,
      cursor: args.cursor,
    },
  });
}
