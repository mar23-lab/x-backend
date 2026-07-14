// allowed-actions.ts · M4 (260707) · the server-derived authority projection.
//
// Cross-cutting invariant #1 (ACCESS_CONTROL_MATRIX.md): AUTHORITY IS SERVER-DERIVED, NEVER
// CLIENT-COMPUTED. This module is the single place that turns an AuthContext + a resource kind into the
// exact action set the caller may take, plus a human-readable reason for each action they may NOT — so
// the cockpit (and the future UI's permission axes) render a disabled control WITH its reason instead of
// re-deriving authority client-side (the GAP-004 class) or discovering the denial only via a surprise 403.
//
// Faithful to docs/security/ACCESS_CONTROL_MATRIX.md. Additive: attaches `allowed_actions` +
// `disabled_reasons` to a response envelope, changing no existing field. Pure (no ctx / no DB / no I/O)
// so it is unit-testable and cannot leak tenant data.

import type { AuthContext } from '../dal/types/auth';

export type ResourceKind =
  | 'project'
  | 'event'
  | 'project_source'
  | 'source'
  | 'member'
  | 'sign_off'
  | 'api_token'
  | 'document'
  // A-W2c (260707) · the resources the old-UI widget migration consumes.
  | 'workspace'
  | 'synthetic_domain'
  // Wave C M4 (260708) · model-runtime provider config (routes/model-runtimes.ts).
  | 'model_runtime'
  // Wave I (260714) · the customer-safe Current Work read-projection (routes/current-work.ts).
  | 'current_work';

export interface Authority {
  allowed_actions: string[];
  disabled_reasons: Record<string, string>;
}

type Rule = { allow: (a: AuthContext) => boolean; deny: string };

const isOwner = (a: AuthContext) => a.role === 'owner';
const isOwnerOrOperator = (a: AuthContext) => a.role === 'owner' || a.role === 'operator';
const isMemberRole = (a: AuthContext) => a.role === 'owner' || a.role === 'operator' || a.role === 'viewer';
// A service-principal token (canary / customer connector) is read-only at this layer — writes are fenced
// to the packet-scoped MCP surface, never the tenant REST resources projected here.
const isServicePrincipal = (a: AuthContext) => Boolean(a.service_principal);

const R = {
  ownerOnly: { allow: isOwner, deny: 'requires the workspace owner role' } as Rule,
  ownerOrOperator: {
    allow: (a: AuthContext) => isOwnerOrOperator(a) && !isServicePrincipal(a),
    deny: 'requires the owner or operator role',
  } as Rule,
  memberRead: { allow: isMemberRole, deny: 'the client role cannot read this resource' } as Rule,
  anyMember: { allow: (a: AuthContext) => a.role !== 'client', deny: 'not permitted for the client role' } as Rule,
  // Events read is open to every role — the client sees only the public_safe tier (visibility-filtered
  // in the DAL, ACCESS_CONTROL_MATRIX.md row "Events: read"), so the action itself is always allowed.
  everyoneRead: { allow: () => true, deny: 'unreachable' } as Rule,
};

// The action → rule matrix per resource. Order defines the projected `allowed_actions` order.
const MATRIX: Record<ResourceKind, Record<string, Rule>> = {
  project: {
    read: R.memberRead,
    create: R.ownerOrOperator,
    edit: R.ownerOrOperator,
    archive: R.ownerOrOperator,
    restore: R.ownerOrOperator,
  },
  event: {
    read: R.everyoneRead,
    create: R.ownerOrOperator,
    status_repoint: R.ownerOrOperator,
    archive: R.ownerOrOperator,
    restore: R.ownerOrOperator,
  },
  project_source: {
    read: R.memberRead,
    connect: R.ownerOrOperator,
    disconnect: R.ownerOrOperator,
    reconnect: R.ownerOrOperator,
  },
  source: {
    read: R.anyMember,
    connect: R.ownerOrOperator,
    disconnect: R.ownerOrOperator,
    sync: R.ownerOrOperator,
  },
  member: {
    read: R.memberRead,
    role_change: R.ownerOnly, // last-owner-guarded + audited at the route; owner-only entry here
    invite: R.ownerOrOperator,
  },
  sign_off: {
    read: R.memberRead,
    create: R.ownerOrOperator,
  },
  api_token: {
    read: R.ownerOrOperator,
    mint: R.ownerOrOperator,
    revoke: R.ownerOrOperator,
  },
  document: {
    read: R.anyMember,
    upload: R.anyMember, // any workspace member with a workspace; no role gate at the route
  },
  // A-W2c · workspace-level authority (routes: workspaces.ts — activity-summary/plan block client;
  // PATCH/DELETE + project-create are owner/operator). Consumed by DetailedWorkspaceShellDesign.
  workspace: {
    read: R.memberRead,
    create: R.ownerOrOperator,
    edit: R.ownerOrOperator,
    archive: R.ownerOrOperator,
    create_project: R.ownerOrOperator,
  },
  // A-W2c · synthetic-domain (department lens) authority (routes: synthetic-domains.ts — reads block
  // client; all writes require isOperatorContext = owner/operator). Consumed by SyntheticDomainsPanel.
  synthetic_domain: {
    read: R.memberRead,
    create: R.ownerOrOperator,
    edit: R.ownerOrOperator,
    archive: R.ownerOrOperator,
    refresh_membership: R.ownerOrOperator,
  },
  // Wave C M4 · model-runtime provider config (routes/model-runtimes.ts). Reads = any member except client
  // (masked ····last4); writes (set/delete/set_default) = owner/operator — the route enforces isOperatorContext,
  // and the MB-P orgless operator (role→'viewer') is granted via override, so the envelope stays faithful to
  // the actual gate (not a role-only projection that would hide the manage actions from that operator).
  // set_override is a per-user session preference open to any non-client member.
  model_runtime: {
    read: R.memberRead,
    set: R.ownerOrOperator,
    delete: R.ownerOrOperator,
    set_default: R.ownerOrOperator,
    set_override: R.anyMember,
  },
  // Wave I · Current Work is a READ-ONLY projection; the actionable verbs live on the underlying
  // event/sign_off resources, not on the projection. review = open the item; the client role sees the
  // public_safe tier only (visibility-filtered upstream), so read is member-scoped.
  current_work: {
    read: R.memberRead,
    review: R.anyMember,
  },
};

const SERVICE_PRINCIPAL_WRITE_DENY = 'service-principal tokens are read-only on tenant resources';

/**
 * Override for authority the pure ROLE matrix cannot express — e.g. DB workspace-ownership, which is not a
 * value on AuthContext.role (Clerk maps org:admin→'operator'; the true owner is workspaces.owner_user_id).
 * The route computes the real predicate (operatorOwnsWorkspace) and passes the granted actions here so the
 * envelope stays FAITHFUL to the route's actual enforcement instead of a role-only approximation that never
 * fires (the A-W2f "dead editor" class: role_change=R.ownerOnly but no AuthContext ever has role 'owner').
 */
export interface AuthorityOverride {
  grant?: readonly string[];
}

/**
 * Project the caller's authority over one resource kind. Returns the allowed action list plus, for every
 * action the caller may NOT take, a reason the UI can render on a disabled control. Server truth only.
 * `override.grant` force-allows actions the route has authorized out-of-band (DB ownership etc.).
 */
export function authorityFor(auth: AuthContext, resource: ResourceKind, override?: AuthorityOverride): Authority {
  const rules = MATRIX[resource];
  const allowed_actions: string[] = [];
  const disabled_reasons: Record<string, string> = {};
  for (const [action, rule] of Object.entries(rules)) {
    if (rule.allow(auth)) {
      allowed_actions.push(action);
    } else {
      // Prefer the more specific service-principal reason when that is the actual blocker.
      disabled_reasons[action] =
        isServicePrincipal(auth) && rule === R.ownerOrOperator ? SERVICE_PRINCIPAL_WRITE_DENY : rule.deny;
    }
  }
  if (override?.grant) {
    for (const action of override.grant) {
      // HARDENING (retro P2): only grant an action the MATRIX actually DEFINES for this resource. A route can
      // supplement authority the pure role-matrix can't express (DB ownership), but it must never inject a
      // fabricated action name into allowed_actions — that would let a caller bug widen the server-derived
      // authority contract past the matrix. Unknown action → skipped (no-op), not granted.
      if (!Object.prototype.hasOwnProperty.call(rules, action)) continue;
      if (!allowed_actions.includes(action)) allowed_actions.push(action);
      delete disabled_reasons[action];
    }
  }
  return { allowed_actions, disabled_reasons };
}

/**
 * Attach `allowed_actions` + `disabled_reasons` to a response payload for one resource kind. Additive —
 * existing keys preserved. Pair with withDataClass() at a tenant-facing ctx.json() return.
 */
export function withAuthority<T extends object>(
  payload: T,
  auth: AuthContext,
  resource: ResourceKind,
  override?: AuthorityOverride,
): T & Authority {
  // T extends object (not Record<string, unknown>) so typed route payloads — `{ projects: Project[] }`,
  // `{ members } & Authority`, etc. — are accepted without an index signature. Object spread is valid
  // for any object shape and the T & Authority result type is preserved for callers.
  return { ...payload, ...authorityFor(auth, resource, override) };
}
