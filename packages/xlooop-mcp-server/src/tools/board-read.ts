// tools/board-read.ts · xlooop.board.read
//
// Reads the board cards surface for a workspace. Used by Claude Code to
// understand what is currently on the operator's board (todo / doing /
// review / done).

import { apiRequest } from '../api-client.js';
import type { BoardCardsResponse } from '../types.js';

export const boardReadDefinition = {
  name: 'xlooop.board.read',
  description:
    'Read the workspace board cards. Board cards represent tracked work items in lanes (todo / doing / review / done / blocked). ' +
    'A board card is the operator-curated view of intent, while xlooop.event.list returns the raw activity stream. ' +
    'Use board.read when you want the current backlog/work-in-progress state. Use event.list when you want recent activity (writes, deltas, decisions). ' +
    'Filter by project_id or status to narrow scope.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string', description: 'Source workspace id' },
      project_id: { type: 'string', description: 'Optional filter to a single project' },
      status: { type: 'string', description: 'Optional status filter (todo, doing, review, done, blocked)' },
    },
    required: ['workspace_id'],
    additionalProperties: false,
  },
} as const;

export async function boardRead(args: {
  workspace_id: string;
  project_id?: string;
  status?: string;
}): Promise<BoardCardsResponse> {
  return apiRequest<BoardCardsResponse>(`/api/v1/board-cards`, {
    method: 'GET',
    query: {
      workspace_id: args.workspace_id,
      project_id: args.project_id,
      status: args.status,
    },
  });
}
