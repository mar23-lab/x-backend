// tools/signoff-create.ts · xlooop.signoff.create
//
// Create a sign-off request. The MCP client proposes an action; the
// operator approves/rejects via the Xlooop app UI. Pair with
// xlooop.signoff.await to block the Claude session until the operator decides.

import { apiRequest } from '../api-client.js';
import type { SignOff, SignOffCreateInput } from '../types.js';

// R44.1 M4: reason is semantically mandatory — operator approval prompt is
// useless without it. Keep TS type narrowed at the call boundary.
export type SignOffCreateArgs = { workspace_id: string; reason: string } & Omit<SignOffCreateInput, 'reason'>;

export const signoffCreateDefinition = {
  name: 'xlooop.signoff.create',
  description:
    'Create a pending sign-off request. Operator reviews in the Xlooop app and approves/rejects. ' +
    'Returns the sign-off id; pair with xlooop.signoff.await to block until decided.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string', description: 'Workspace for the sign-off' },
      project_id: { type: 'string', description: 'Optional project context' },
      event_id: { type: 'string', description: 'Optional event id the sign-off is gating' },
      reviewer_user_id: { type: 'string', description: 'Optional specific reviewer; falls back to workspace owners' },
      reason: { type: 'string', description: 'Why this needs sign-off — operator-readable' },
      metadata: { type: 'object', additionalProperties: true, description: 'Free-form metadata payload' },
    },
    required: ['workspace_id', 'reason'],
    additionalProperties: false,
  },
} as const;

export async function signoffCreate(args: SignOffCreateArgs): Promise<SignOff> {
  const { workspace_id, ...rest } = args;
  return apiRequest<SignOff>(`/api/v1/sign-offs`, {
    method: 'POST',
    body: { workspace_id, ...rest },
  });
}
