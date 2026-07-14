// tools/project-set-scope.ts · xlooop.project.set_scope
//
// Operator-tier write tool: configure which workspace events filter into a
// project's detail view. Without a scope binding, project detail shows only
// events that were explicitly written with project_id=this. With a binding,
// workspace-level events matching the filters ALSO appear in the project view.
//
// Requires owner or operator role (Worker enforces). Client/member roles get 403.

import { apiRequest } from '../api-client.js';
import type { Project } from '../types.js';

export const projectSetScopeDefinition = {
  name: 'xlooop.project.set_scope',
  description:
    'Set or clear a project\'s scope_binding — a declarative filter for which workspace events appear in the project detail view. ' +
    'Pass null to clear (project shows only directly-linked events). Pass a binding to filter by actor patterns (e.g. "claude-session-*"), ' +
    'source_tool, status, or visibility. Requires owner or operator role. Use xlooop.project.get first to inspect the current binding.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project id (e.g. "proj_001")' },
      scope_binding: {
        type: 'object',
        description:
          'Scope binding · null clears. Shape: ' +
          '{ version: 1, combine: "any"|"all", filters: [{ type: "actor_in"|"source_tool_in"|"status_in"|"visibility_in", values: [string, ...] }] }. ' +
          'actor_in values may use * wildcards (e.g. "claude-session-*"). combine="any" matches if ANY filter matches; "all" requires every populated filter to match.',
        properties: {
          version: { type: 'integer', minimum: 1, maximum: 1 },
          combine: { type: 'string' },
          filters: { type: 'array', items: { type: 'object' } },
        },
        required: ['version', 'combine', 'filters'],
      },
    },
    required: ['project_id', 'scope_binding'],
    additionalProperties: false,
  },
} as const;

export interface ScopeFilter {
  type: 'actor_in' | 'source_tool_in' | 'status_in' | 'visibility_in';
  values: string[];
}

export interface ScopeBinding {
  version: 1;
  combine: 'any' | 'all';
  filters: ScopeFilter[];
}

export async function projectSetScope(args: {
  project_id: string;
  scope_binding: ScopeBinding | null;
}): Promise<{ project: Project }> {
  return apiRequest<{ project: Project }>(`/api/v1/projects/${encodeURIComponent(args.project_id)}/scope`, {
    method: 'PATCH',
    body: { scope_binding: args.scope_binding },
  });
}
