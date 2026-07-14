// tools/project-get.ts · xlooop.project.get
//
// Returns a single project including its scope_binding. Used by an MCP client
// to inspect the current binding before proposing a change via project.set_scope.

import { apiRequest } from '../api-client.js';
import type { Project } from '../types.js';

export const projectGetDefinition = {
  name: 'xlooop.project.get',
  description:
    'Fetch a single project by id, including its current scope_binding configuration. ' +
    'Returns the full Project row (id, workspace_id, name, status, description, scope_binding). ' +
    'Pair with xlooop.project.set_scope to inspect-then-modify the binding.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project id (e.g. "proj_001")' },
    },
    required: ['project_id'],
    additionalProperties: false,
  },
} as const;

export async function projectGet(args: { project_id: string }): Promise<{ project: Project }> {
  return apiRequest<{ project: Project }>(`/api/v1/projects/${encodeURIComponent(args.project_id)}`, {
    method: 'GET',
  });
}
