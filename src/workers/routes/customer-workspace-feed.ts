// customer-workspace-feed.ts · customer-safe starter/read-only feed.
//
// This is the product-data counterpart to /developer-access/status. It is not an
// operator cockpit route, not a graph export, and not a second data plane: it
// reads the existing tenant-scoped DAL through the same Clerk org authority and
// returns only starter content a new customer can safely consume on day 1.

import { Hono } from 'hono';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { HarnessFlowEvent, SessionProject } from '../dal/types';

export interface CustomerWorkspaceFeedEnv extends AuthEnv {
  DATABASE_URL: string;
}

export interface CustomerWorkspaceFeedVariables extends AuthVariables {
  dal: DalAdapter;
}

export const customerWorkspaceFeedRoute = new Hono<{
  Bindings: CustomerWorkspaceFeedEnv;
  Variables: CustomerWorkspaceFeedVariables;
}>();

customerWorkspaceFeedRoute.get('/customer/workspace-feed', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const dal = ctx.get('dal');
    const entitlement = await dal.getSessionEntitlement(auth.user_id, auth.workspace_id, auth.email ?? null);

    if (entitlement.state !== 'approved_workspace') {
      ctx.status(403);
      return ctx.json({
        error: 'workspace is not provisioned for this signed-in organization',
        code: 'FORBIDDEN',
        request_id: ctx.get('request_id'),
        state: entitlement.state,
      });
    }

    const session = await dal.getSession(auth.user_id, auth.workspace_id);
    const projects = Array.isArray(session.projects) ? session.projects : [];
    const eventPage = await dal.listEvents(auth.workspace_id, {
      role: auth.role,
      limit: 8,
      top_level: true,
    }).catch(() => ({ events: [], pagination: { has_more: false, next_before: null } }));
    const now = new Date().toISOString();

    return ctx.json(withDataClass({
      schema_id: 'xlooop.customer_workspace_feed.v1',
      generated_at: now,
      readiness_state: 'read_only_validation',
      workspace: {
        id: session.workspace.id,
        label: safeLabel(session.workspace.name, 'Current workspace'),
        slug: session.workspace.slug,
      },
      user: {
        label: auth.email || session.user.email || 'Signed-in workspace member',
        role: session.user.role,
      },
      starter_pack: buildStarterPack(session.workspace.name, projects),
      projects: projects.map(projectSummary),
      recent_events: eventPage.events.map(eventSummary),
      source_checklist: [
        { id: 'authority', label: 'Confirm workspace authority', status: 'pending' },
        { id: 'first_source', label: 'Connect a first source', status: 'pending' },
        { id: 'desktop_identity', label: 'Validate Claude Code, Codex, or Cursor identity', status: 'available' },
        { id: 'write_unlock', label: 'Unlock write access after live authority proof', status: 'blocked' },
      ],
      api_access: {
        status: 'read_only_validation',
        allowed_endpoints: [
          '/api/v1/session',
          '/api/v1/customer/workspace-feed',
          '/api/v1/developer-access/status',
          '/api/v1/developer-access/test',
          '/api/v1/mcp/whoami',
          '/api/v1/mcp/tools',
        ],
        blocked_until: [
          'production database isolation proof passes',
          'scoped token revocation proof passes',
          'delete/export/legal-hold receipt proof passes',
          'two-company isolation proof passes',
          'external tool canary proof passes',
        ],
      },
    }, 'starter'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

function buildStarterPack(workspaceName: string, projects: SessionProject[]) {
  const project = projects[0];
  return {
    title: `${safeLabel(workspaceName, 'Workspace')} starter workspace`,
    summary: 'Use this read-only workspace to confirm identity, starter context, source readiness, and desktop API setup before write access is enabled.',
    day_1: [
      project ? `Review project ${safeLabel(project.name, 'starter project')}.` : 'Review the default starter project.',
      'Run the Developer Access Center connection check.',
      'Choose the first source to connect.',
      'Confirm the first business outcome this workspace should track.',
    ],
  };
}

function projectSummary(project: SessionProject) {
  return {
    id: project.id,
    label: safeLabel(project.name, project.id),
    status: project.status,
  };
}

function eventSummary(event: HarnessFlowEvent) {
  return {
    id: event.id,
    project_id: event.project_id,
    status: event.status,
    summary: event.summary,
    next_action: event.next_action,
    occurred_at: event.occurred_at,
  };
}

function safeLabel(value: string | null | undefined, fallback: string) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^org_[a-z0-9]+$/i.test(raw)) return fallback;
  return raw;
}
