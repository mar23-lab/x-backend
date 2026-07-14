// developer-access.ts · customer-safe API/Desktop setup projection + controlled token issuer.
//
// It turns the already-authenticated Clerk org session into customer-readable setup metadata and
// a redacted connection-test receipt. It ALSO mints scoped, revocable customer connector tokens
// (migration 037) — but only for a human owner/operator Clerk session, never a service principal,
// and only when the feature flags are set (CUSTOMER_API_TOKENS_ENABLED for read-only viewer
// tokens; CUSTOMER_OPERATIONAL_TOKENS_ENABLED for operator/write tokens). Inert by default.

import { Hono } from 'hono';
import { envFlagTrue } from '../lib/env-flag';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { AuthContext } from '../dal/types';
import {
  CUSTOMER_MCP_CONNECTOR_NAMESPACE,
  FORBIDDEN_SURFACES as MCP_FORBIDDEN_SURFACES,
  SAFE_TOOLS,
} from './mcp-gateway';
import { whoamiEnvelope } from './template-policy-registry';
import { hashToken } from '../dal/customer-token-store';
import { authorizeGovernedWrite } from '../lib/spine-authority';

export interface DeveloperAccessEnv extends AuthEnv {
  DATABASE_URL: string;
  // Connector-token feature is INERT until these are set (see migration 037).
  // CUSTOMER_API_TOKENS_ENABLED (inherited from AuthEnv) gates read-only viewer tokens.
  // CUSTOMER_OPERATIONAL_TOKENS_ENABLED additionally gates operator (write) tokens.
  CUSTOMER_OPERATIONAL_TOKENS_ENABLED?: string;
}

export interface DeveloperAccessVariables extends AuthVariables {
  dal: DalAdapter;
}

export const developerAccessRoute = new Hono<{
  Bindings: DeveloperAccessEnv;
  Variables: DeveloperAccessVariables;
}>();

const SUPPORTED_CLIENTS = ['Claude Code', 'Codex', 'Cursor', 'Browser test'] as const;
const READ_ONLY_ENDPOINTS = [
  '/api/v1/session',
  '/api/v1/customer/workspace-feed',
  '/api/v1/developer-access/status',
  '/api/v1/developer-access/test',
  '/api/v1/mcp/whoami',
  '/api/v1/mcp/tools',
] as const;
const FULL_API_BLOCKERS = [
  'Production database isolation proof is pending.',
  'Scoped token revocation proof is pending.',
  'Delete, export, and legal-hold receipt proof is pending.',
  'Two-company isolation proof is pending.',
  'External tool canary proof is pending.',
] as const;

developerAccessRoute.get('/developer-access/status', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const entitlement = await ctx.get('dal').getSessionEntitlement(auth.user_id, auth.workspace_id, auth.email ?? null);
    const workspaceName = entitlement.state === 'approved_workspace'
      ? entitlement.workspace?.name || humanizeTenant(auth.workspace_id)
      : humanizeTenant(auth.workspace_id);
    return ctx.json(buildStatus(auth, workspaceName));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

developerAccessRoute.post('/developer-access/test', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    const entitlement = await ctx.get('dal').getSessionEntitlement(auth.user_id, auth.workspace_id, auth.email ?? null);
    const workspaceName = entitlement.state === 'approved_workspace'
      ? entitlement.workspace?.name || humanizeTenant(auth.workspace_id)
      : humanizeTenant(auth.workspace_id);
    const status = buildStatus(auth, workspaceName);
    const whoami = whoamiEnvelope(auth);
    const now = new Date().toISOString();
    return ctx.json({
      schema_id: 'xlooop.developer_access_test_receipt.v1',
      status: 'pass',
      tested_at: now,
      receipt_id: `dev-access-${ctx.get('request_id') || now}`,
      readiness_state: status.readiness_state,
      identity: {
        workspace_label: status.workspace_label,
        user_label: status.user_label,
        role: auth.role,
        membership_resolution: whoami.identity.membership_resolution,
        token_expires_at: auth.token_expires_at ?? null,
      },
      checks: [
        { id: 'session', label: 'Session is authenticated', status: 'pass' },
        { id: 'whoami', label: 'Identity is bound to this workspace', status: 'pass' },
        { id: 'tools', label: 'Tool allowlist is visible', status: 'pass' },
        { id: 'full_api', label: 'Full API remains blocked until live proof passes', status: 'blocked' },
      ],
      allowed_tools: SAFE_TOOLS.map((tool) => tool.name),
      forbidden_surfaces: MCP_FORBIDDEN_SURFACES,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

function buildStatus(auth: AuthContext, workspaceName: string) {
  return {
    schema_id: 'xlooop.developer_access_status.v1',
    readiness_state: 'read_only_validation',
    public_api_ready: false,
    full_api_blocked: true,
    connector_namespace: CUSTOMER_MCP_CONNECTOR_NAMESPACE,
    workspace_label: workspaceName,
    user_label: labelUser(auth),
    supported_clients: SUPPORTED_CLIENTS,
    read_only_endpoints: READ_ONLY_ENDPOINTS,
    allowed_tools: SAFE_TOOLS.map((tool) => ({
      name: tool.name,
      method: tool.method,
      path: tool.path,
      description: describeTool(tool.name),
    })),
    blocked_until: FULL_API_BLOCKERS,
    forbidden_surfaces: MCP_FORBIDDEN_SURFACES,
    setup_policy: {
      oauth_preferred: true,
      browser_validation_available: true,
      customer_token_fallback_status: 'not_enabled_until_revocation_proof',
      token_values_must_not_be_copied_to_chat_or_docs: true,
    },
  };
}

function labelUser(auth: AuthContext): string {
  const email = String(auth.email || '').trim().toLowerCase();
  return email || 'Signed-in workspace member';
}

function humanizeTenant(value: string): string {
  const cleaned = String(value || '').trim();
  if (!cleaned) return 'Current workspace';
  if (/^org_[a-z0-9]+$/i.test(cleaned)) return 'Current workspace';
  return cleaned
    .replace(/^proj_/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase()) || 'Current workspace';
}

function describeTool(name: string): string {
  if (name === 'xlooop.whoami') return 'Confirm the connected user and workspace.';
  if (name === 'xlooop.get_task_packet') return 'Read a scoped task packet.';
  if (name === 'xlooop.get_workflow_status') return 'Read workflow status for an allowed packet.';
  if (name === 'xlooop.get_effective_templates') return 'Read redacted effective templates.';
  if (name === 'xlooop.get_effective_profile') return 'Read the effective personalization profile.';
  if (name === 'xlooop.submit_learning_signal') return 'Submit a governed learning signal.';
  if (name === 'xlooop.submit_evidence') return 'Submit metadata/evidence against an allowed packet.';
  if (name === 'xlooop.report_tool_event') return 'Report a tool event against an allowed packet.';
  if (name === 'xlooop.request_approval') return 'Request approval for governed work.';
  return 'Tenant-scoped Xlooop tool.';
}

// ============================================================
// Controlled connector-token issuer (migration 037)
// ------------------------------------------------------------
// Human owner/operator Clerk session only. A service principal (canary / customer token) can
// never mint. Read-only viewer tokens need CUSTOMER_API_TOKENS_ENABLED; operator (write) tokens
// additionally need CUSTOMER_OPERATIONAL_TOKENS_ENABLED (the controlled fallback after lifecycle +
// revocation proof). Raw token is returned ONCE; only its SHA-256 is stored.
// ============================================================

function devJsonError(ctx: any, status: 400 | 403 | 404 | 409 | 503, code: string, error: string) {
  ctx.status(status);
  return ctx.json({ error, code, request_id: ctx.get('request_id') });
}

async function devJsonBody(ctx: any): Promise<Record<string, unknown> | null> {
  const body = await ctx.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function slugifyWorkspace(workspaceId: string): string {
  return (
    String(workspaceId || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'ws'
  );
}

function mintRawToken(role: 'viewer' | 'operator'): string {
  const hex = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  return `xlk_${role === 'operator' ? 'op' : 'ro'}_${hex}`;
}

developerAccessRoute.post('/developer-access/tokens', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (auth.auth_method !== 'clerk_jwt') {
      return devJsonError(ctx, 403, 'FORBIDDEN', 'tokens can only be minted from a human owner/operator session');
    }
    if (!(await authorizeGovernedWrite(ctx, 'token:create')).allowed) {
      return devJsonError(ctx, 403, 'FORBIDDEN', 'only workspace owners or operators may mint connector tokens');
    }
    if (!envFlagTrue(ctx.env.CUSTOMER_API_TOKENS_ENABLED)) {
      return devJsonError(ctx, 409, 'CONFLICT', 'customer connector tokens are not enabled for this deployment yet');
    }
    const body = await devJsonBody(ctx);
    const role: 'viewer' | 'operator' = body?.role === 'operator' ? 'operator' : 'viewer';
    if (role === 'operator' && !envFlagTrue(ctx.env.CUSTOMER_OPERATIONAL_TOKENS_ENABLED)) {
      return devJsonError(ctx, 409, 'CONFLICT', 'operator (write) tokens require lifecycle + revocation proof; not enabled yet');
    }
    const label =
      typeof body?.label === 'string' && body.label.trim()
        ? body.label.trim().slice(0, 80)
        : `${role === 'operator' ? 'Operational' : 'Read-only'} connector`;
    const raw = mintRawToken(role);
    const token_sha256 = await hashToken(raw);
    const expires_at = new Date(Date.now() + 90 * 86400000).toISOString();
    const packet_prefix = `pkt-${slugifyWorkspace(auth.workspace_id)}-`;
    const created = await ctx.get('dal').createCustomerToken({
      workspace_id: auth.workspace_id,
      token_sha256,
      role,
      label,
      packet_prefix,
      created_by: auth.user_id,
      expires_at,
    });
    // A-W1 · session/token lifecycle audit (target_type 'api_token', migration 048). Best-effort:
    // a failed audit must NEVER block the mint, but it is LOGGED (audit loss must be visible, not silent).
    try {
      await ctx.get('dal').appendAuditLog({
        actor_user_id: auth.user_id,
        action: 'customer_token_mint',
        target_type: 'api_token',
        target_id: created.id,
        workspace_id: auth.workspace_id,
        reason: `Connector token minted (${created.role}): ${created.label}`,
        metadata: { request_id: ctx.get('request_id'), role: created.role, expires_at: created.expires_at },
      });
    } catch (err) {
      console.warn('[developer-access] token-mint audit failed (best-effort)', { workspace_id: auth.workspace_id, error: (err as Error)?.message });
    }
    ctx.status(201);
    return ctx.json({
      schema_id: 'xlooop.customer_token_minted.v1',
      token: raw,
      token_id: created.id,
      role: created.role,
      label: created.label,
      expires_at: created.expires_at,
      mode: role === 'operator' ? 'operational' : 'read_only',
      warning:
        'Store this token in your agent config now. It is shown once and never again. Never paste it into chat, docs, tickets, or email.',
      connect: {
        endpoint: 'https://api.xlooop.com/api/v1/mcp',
        whoami_check: `curl -s https://api.xlooop.com/api/v1/mcp/whoami -H "Authorization: Bearer ${raw}"`,
      },
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

developerAccessRoute.get('/developer-access/tokens', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!(await authorizeGovernedWrite(ctx, 'token:read')).allowed) {
      return devJsonError(ctx, 403, 'FORBIDDEN', 'only workspace owners or operators may list connector tokens');
    }
    const tokens = await ctx.get('dal').listCustomerTokens(auth.workspace_id);
    return ctx.json({ schema_id: 'xlooop.customer_token_list.v1', tokens });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

developerAccessRoute.delete('/developer-access/tokens/:id', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (auth.role !== 'owner' && auth.role !== 'operator') {
      return devJsonError(ctx, 403, 'FORBIDDEN', 'only workspace owners or operators may revoke connector tokens');
    }
    const revoked = await ctx.get('dal').revokeCustomerToken(auth.workspace_id, ctx.req.param('id'), auth.user_id);
    // A-W1 · session/token lifecycle audit. Best-effort — never block the revoke; log on failure.
    try {
      await ctx.get('dal').appendAuditLog({
        actor_user_id: auth.user_id,
        action: 'customer_token_revoke',
        target_type: 'api_token',
        target_id: revoked.id,
        workspace_id: auth.workspace_id,
        reason: `Connector token revoked: ${revoked.id}`,
        metadata: { request_id: ctx.get('request_id'), revoked_at: revoked.revoked_at },
      });
    } catch (err) {
      console.warn('[developer-access] token-revoke audit failed (best-effort)', { workspace_id: auth.workspace_id, error: (err as Error)?.message });
    }
    return ctx.json({
      schema_id: 'xlooop.customer_token_revoked.v1',
      token_id: revoked.id,
      revoked_at: revoked.revoked_at,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
