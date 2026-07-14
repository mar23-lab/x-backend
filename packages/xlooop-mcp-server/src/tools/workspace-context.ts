// tools/workspace-context.ts · xlooop.workspace.context
//
// Returns the operator-scoped session context for the authenticated caller.
// Identifies which workspace they're in, what role they have, what projects
// exist, etc. Useful as the first call any MCP client makes after auth.

import { apiRequest } from '../api-client.js';
import type { SessionResponse } from '../types.js';

export const workspaceContextDefinition = {
  name: 'xlooop.workspace.context',
  description:
    'Get the authenticated session context. Returns the user identity, current workspace, role, ' +
    'and a project summary. This is the recommended first call for an MCP client after the credential ' +
    'is loaded — it confirms the token works and exposes the workspace_id to use in subsequent tools.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
} as const;

export async function workspaceContext(): Promise<SessionResponse> {
  return apiRequest<SessionResponse>(`/api/v1/session`, { method: 'GET' });
}
