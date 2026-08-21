import { Hono } from 'hono';
import type { AuthVariables } from '../middleware/auth';
import type { AdminEnv } from '../middleware/admin';
import { errorEnvelope } from '../middleware/error';
import type { DalAdapter } from '../dal/DalAdapter';
import {
  WORKSPACE_RELATIONSHIP_STATUSES,
  type WorkspaceRelationshipStatus,
} from '../dal/workspace-relationship-store';

type Variables = AuthVariables & { dal: DalAdapter; request_id: string };

export const workspaceRelationshipRoute = new Hono<{
  Bindings: AdminEnv;
  Variables: Variables;
}>();

workspaceRelationshipRoute.post('/workspaces/:workspace_id/relationship-status', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.is_admin) {
      return errorEnvelope(ctx, {
        status: 403,
        code: 'FORBIDDEN',
        message: 'platform admin privilege required',
      });
    }
    const workspaceId = String(ctx.req.param('workspace_id') || '').trim();
    const body = await ctx.req.json().catch(() => ({})) as {
      relationship_status?: string;
      expected_current_status?: string;
      reason?: string;
    };
    if (!WORKSPACE_RELATIONSHIP_STATUSES.includes(body.relationship_status as WorkspaceRelationshipStatus)
      || !WORKSPACE_RELATIONSHIP_STATUSES.includes(body.expected_current_status as WorkspaceRelationshipStatus)) {
      return errorEnvelope(ctx, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'relationship_status and expected_current_status must be valid lifecycle states',
      });
    }
    const receipt = await ctx.get('dal').transitionWorkspaceRelationshipStatus(workspaceId, {
      relationship_status: body.relationship_status as WorkspaceRelationshipStatus,
      expected_current_status: body.expected_current_status as WorkspaceRelationshipStatus,
      actor_user_id: auth.user_id,
      request_id: ctx.get('request_id'),
      reason: String(body.reason || ''),
    });
    return ctx.json({
      _meta: {
        schema: 'xlooop.workspace_relationship_transition_receipt.v1',
        request_id: ctx.get('request_id'),
        authority: 'platform_admin_only',
      },
      receipt,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
