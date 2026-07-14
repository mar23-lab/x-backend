// tools/project-list.ts · xlooop.project.list
//
// Enumerates projects in a workspace. Used by Claude Code agents to
// discover what targets they can append events against.

import { apiRequest } from '../api-client.js';
import type { ProjectListResponse } from '../types.js';

export const projectListDefinition = {
  name: 'xlooop.project.list',
  description:
    'Enumerate projects in a workspace with full project objects (id, workspace_id, name, status, plus tenant extension fields). ' +
    'Returns more detail than xlooop.workspace.context\'s embedded project summary — call this when you need the full Project rows ' +
    'before appending events to a specific project, or when you need to filter by status outside the default active set. ' +
    'Default: returns only status != "archived".',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string', description: 'Source workspace id' },
      include_archived: { type: 'boolean', description: 'Include status=archived projects (default false)' },
    },
    required: ['workspace_id'],
    additionalProperties: false,
  },
} as const;

export async function projectList(args: {
  workspace_id: string;
  include_archived?: boolean;
}): Promise<ProjectListResponse> {
  return apiRequest<ProjectListResponse>(`/api/v1/projects`, {
    method: 'GET',
    query: {
      workspace_id: args.workspace_id,
      include_archived: args.include_archived ?? false,
    },
  });
}
