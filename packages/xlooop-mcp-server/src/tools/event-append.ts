// tools/event-append.ts · xlooop.event.append
//
// Use case: an MCP client (Claude Code session, automation, agent) appends
// an operation event to a workspace. This is the PRIMARY write path from
// agents into the Xlooop operator dashboard.
//
// Idempotency: caller may supply `id` for retry-safe writes.

import { apiRequest } from '../api-client.js';
import type { EventAppendInput, OperationEvent } from '../types.js';

export const eventAppendDefinition = {
  name: 'xlooop.event.append',
  description:
    'Append an operation event to a workspace (and optionally a project). ' +
    'Use this to log claude-session activity, file edits, governance decisions, or any operator-visible signal. ' +
    'Idempotent on `id` — supply your own if you want retry safety.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string', description: 'Target workspace id (e.g. "mbp-private")' },
      project_id: { type: 'string', description: 'Optional project id to scope the event' },
      id: { type: 'string', description: 'Optional event id for idempotency (any unique string)' },
      source_tool: { type: 'string', description: 'Identifier of the tool emitting the event (e.g. "claude-code", "ci")' },
      status: { type: 'string', description: 'Event lifecycle status (e.g. "completed", "in-progress", "blocked")' },
      summary: { type: 'string', description: 'Short headline shown in the operator stream' },
      body: { type: 'string', description: 'Longer body / markdown / details' },
      visibility: { type: 'string', description: 'Visibility scope (default "internal_workspace")' },
      occurred_at: { type: 'string', description: 'ISO timestamp; defaults to server now()' },
      actor: { type: 'string', description: 'Who emitted the event (e.g. "claude-session-abc123")' },
    },
    required: ['workspace_id', 'source_tool', 'status', 'summary'],
    // R44.1 M1: consistent with all other tools. Tenant extension fields belong
    // in the `body` string (markdown payload), not as new top-level keys.
    additionalProperties: false,
  },
} as const;

export async function eventAppend(args: { workspace_id: string } & EventAppendInput): Promise<OperationEvent> {
  const { workspace_id, ...rest } = args;
  return apiRequest<OperationEvent>(`/api/v1/events`, {
    method: 'POST',
    body: { workspace_id, ...rest },
  });
}
