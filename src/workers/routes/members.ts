// members.ts · GET /api/v1/members  (Stage 3 · real-data program)
//
// The REAL members of the caller's CURRENT workspace, from the Neon `workspace_members`
// table (the accepted-membership source of truth). WORKSPACE-SCOPED: reads members for the
// auth's own workspace_id (org_id) only — a caller can never enumerate another tenant's
// members. READ-ONLY. Mounted in the org-scoped protectedRoutes group (requireOrg:true).
//
// "real, or honestly-absent": when the workspace has no member rows yet, returns an empty
// list (the frontend renders an honest empty state), never a fabricated roster. DAL errors
// degrade to an empty list (never 5xx). Replaces the static data/ws-detail.json seed the
// Members screen reads today. Pending Clerk invites (not yet accepted) are intentionally NOT
// listed here — this endpoint is the DB's accepted-member truth; surfacing pending invites is
// a separate follow-on.

import { Hono } from 'hono';
import { envFlagTrue } from '../lib/env-flag';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { withAuthority } from '../lib/allowed-actions';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { WorkspaceMember, WorkspaceMemberRole } from '../dal/types';

const VALID_MEMBER_ROLES: WorkspaceMemberRole[] = ['owner', 'operator', 'viewer', 'client'];

export interface MembersEnv extends AuthEnv {
  DATABASE_URL: string;
  // A1 · gates DELETE /members/:userId (member removal). Default OFF — inert until the operator flips it
  // AND migration 062 (workspace_members.removed_at) is applied.
  MEMBER_REMOVAL_ENABLED?: string;
}

export interface MembersVariables extends AuthVariables {
  dal: DalAdapter;
}

export const membersRoute = new Hono<{ Bindings: MembersEnv; Variables: MembersVariables }>();

function requireMemberMutationReceipt(result: { member_mutation_receipt_id?: string; audit_event_id?: string } | null | undefined): string {
  if (!result?.member_mutation_receipt_id || !result.audit_event_id) {
    throw Object.assign(new Error('member mutation did not produce a durable audit receipt'), {
      status: 500,
      code: 'MEMBER_AUDIT_RECEIPT_MISSING',
    });
  }
  return result.member_mutation_receipt_id;
}

membersRoute.get('/members', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    // A-W2c F10 fix · align to ACCESS_CONTROL_MATRIX.md ("Members: list — client ⛔"): the external
    // client role must not enumerate the internal workspace roster (data-minimization). The route
    // previously had NO client check — a matrix↔code drift found by the A-W2c verification pass.
    if (auth.role === 'client') {
      return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'client role cannot list workspace members' });
    }
    // Default to the caller's CURRENT workspace (JWT org_id). The optional
    // ?workspace_id lets the operator read members of ANOTHER workspace THEY OWN
    // (the cockpit shells render multiple workspaces, but the active Clerk org is
    // pinned to one). TENANT GUARD: a caller may only read (a) their current org,
    // or (b) a workspace they own — never another tenant's. The store also calls
    // assertWorkspaceScope.
    const requested = String(ctx.req.query('workspace_id') || '').trim();
    const targetWorkspaceId = requested || auth.workspace_id || '';
    if (!targetWorkspaceId) {
      return errorEnvelope(ctx, { status: 403, code: 'NO_WORKSPACE', message: 'no workspace in session' });
    }
    const dal = ctx.get('dal');
    if (requested && requested !== auth.workspace_id) {
      let owns = false;
      try { owns = await dal.operatorOwnsWorkspace([auth.user_id], requested); } catch (_) { owns = false; }
      if (!owns) {
        return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'not your workspace' });
      }
    }
    // Honest-empty + never-5xx: a workspace with no member rows (or a transient DB
    // error) yields an empty roster, not a fabricated one.
    let members: WorkspaceMember[] = [];
    try {
      members = await dal.listWorkspaceMembers(targetWorkspaceId);
    } catch (_) {
      members = [];
    }
    // A-W2f FIX (F12): role_change is DB-ownership-gated (the PATCH authorizes via operatorOwnsWorkspace),
    // NOT role-gated — and no AuthContext ever carries role 'owner' (Clerk org:admin→'operator'), so the
    // pure matrix's role_change=R.ownerOnly could never fire and the Settings role editor rendered for
    // nobody. Compute the SAME ownership predicate the write path uses and grant role_change so the
    // envelope is faithful to the route's real enforcement — a non-owner still gets the disabled reason.
    let ownsTarget = false;
    try { ownsTarget = await dal.operatorOwnsWorkspace([auth.user_id], targetWorkspaceId); } catch (_) { ownsTarget = false; }
    return ctx.json(withDataClass(withAuthority(
      { members, workspace_id: targetWorkspaceId, count: members.length },
      auth, 'member', ownsTarget ? { grant: ['role_change'] } : undefined,
    ), 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// GET /api/v1/members/batch?workspace_ids=a,b,c — BATCH roster read. Kills the N+1 (XCP-PLATFORM-DEV-5,
// surfaced by Sentry): the cockpit boot hydrator used to fire one GET /members per operator workspace
// (~16 parallel calls on load). This returns members for MANY workspaces in ONE request + ONE ownership-
// scoped query, grouped by workspace_id. TENANT-SAFE: the store's WHERE returns members only for the
// requested ids the caller OWNS (workspaces.owner_user_id = auth.user_id) or their current org — arbitrary
// ids resolve to no rows, so this can never enumerate another tenant. client role blocked (matrix parity).
membersRoute.get('/members/batch', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    if (auth.role === 'client') {
      return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'client role cannot list workspace members' });
    }
    const ids = String(ctx.req.query('workspace_ids') || '')
      .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50); // bounded — never an unbounded fan-in
    if (ids.length === 0) {
      return ctx.json(withDataClass({ members_by_workspace: {}, count: 0 }, 'live'));
    }
    const dal = ctx.get('dal');
    let membersByWs: Record<string, WorkspaceMember[]> = {};
    try {
      membersByWs = await dal.listWorkspaceMembersForWorkspaces(ids, [auth.user_id], auth.workspace_id || null);
    } catch (_) {
      membersByWs = {}; // honest-empty, never 5xx on a transient DB error
    }
    return ctx.json(withDataClass({ members_by_workspace: membersByWs, count: Object.keys(membersByWs).length }, 'live'));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PATCH /api/v1/members/:userId/role — the in-app role-mutation write path (the gap prior
// audits flagged: workspace_members roles were only set at provisioning/invite time).
// OWNER-ONLY: only a caller who OWNS the target workspace may change roles (the admin:write
// tier). TENANT-SCOPED: the change is confined to the caller's workspace (or another they
// own). AUDITED + last-owner-guarded in the DAL. Returns the updated member.
membersRoute.patch('/members/:userId/role', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const targetUserId = String(ctx.req.param('userId') || '').trim();
    if (!targetUserId) {
      return errorEnvelope(ctx, { status: 400, code: 'BAD_REQUEST', message: 'userId required' });
    }
    let body: { role?: string } = {};
    try { body = (await ctx.req.json()) as { role?: string }; } catch (_) { body = {}; }
    const role = String(body?.role || '').trim() as WorkspaceMemberRole;
    if (!VALID_MEMBER_ROLES.includes(role)) {
      return errorEnvelope(ctx, {
        status: 400, code: 'INVALID_ROLE',
        message: `role must be one of: ${VALID_MEMBER_ROLES.join(', ')}`,
      });
    }
    // Same workspace-resolution + ownership rule as the GET: default to the caller's org;
    // an optional ?workspace_id must be a workspace THEY OWN.
    const requested = String(ctx.req.query('workspace_id') || '').trim();
    const targetWorkspaceId = requested || auth.workspace_id || '';
    if (!targetWorkspaceId) {
      return errorEnvelope(ctx, { status: 403, code: 'NO_WORKSPACE', message: 'no workspace in session' });
    }
    const dal = ctx.get('dal');
    // Owner-only: operatorOwnsWorkspace is the ownership check (owner has admin:write; an
    // operator/viewer/client may not mutate roles).
    let owns = false;
    try { owns = await dal.operatorOwnsWorkspace([auth.user_id], targetWorkspaceId); } catch (_) { owns = false; }
    if (!owns) {
      return errorEnvelope(ctx, {
        status: 403, code: 'FORBIDDEN', message: 'only a workspace owner can change member roles',
      });
    }
    const saved = await dal.setWorkspaceMemberRole(targetWorkspaceId, targetUserId, role, auth.user_id);
    const receiptId = requireMemberMutationReceipt(saved);
    return ctx.json({
      member: saved.member,
      member_mutation_receipt_id: receiptId,
      audit_event_id: saved.audit_event_id,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// A1 (260710-B) · DELETE /members/:userId — SOFT-remove a member (backs the cockpit "Remove from
// workspace" control). Owner-only (same operatorOwnsWorkspace gate as the role PATCH). Flag-gated
// (MEMBER_REMOVAL_ENABLED, default OFF → 409) so the route is inert until the operator flips it AND
// migration 062 is applied. The store enforces the self-removal + last-owner guards and soft-removes
// (removed_at) + audits in one transaction.
membersRoute.delete('/members/:userId', async (ctx) => {
  try {
    if (!envFlagTrue(ctx.env.MEMBER_REMOVAL_ENABLED)) {
      return errorEnvelope(ctx, { status: 409, code: 'CONFLICT', message: 'member removal is not enabled for this deployment yet' });
    }
    const auth = ctx.get('auth');
    if (!auth?.user_id) {
      return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    }
    const targetUserId = String(ctx.req.param('userId') || '').trim();
    if (!targetUserId) {
      return errorEnvelope(ctx, { status: 400, code: 'BAD_REQUEST', message: 'userId required' });
    }
    const requested = String(ctx.req.query('workspace_id') || '').trim();
    const targetWorkspaceId = requested || auth.workspace_id || '';
    if (!targetWorkspaceId) {
      return errorEnvelope(ctx, { status: 403, code: 'NO_WORKSPACE', message: 'no workspace in session' });
    }
    const dal = ctx.get('dal');
    let owns = false;
    try { owns = await dal.operatorOwnsWorkspace([auth.user_id], targetWorkspaceId); } catch (_) { owns = false; }
    if (!owns) {
      return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'only a workspace owner can remove members' });
    }
    const saved = await dal.removeWorkspaceMember(targetWorkspaceId, targetUserId, auth.user_id);
    const receiptId = requireMemberMutationReceipt(saved);
    return ctx.json({
      removed: saved.removed,
      member_mutation_receipt_id: receiptId,
      audit_event_id: saved.audit_event_id,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
