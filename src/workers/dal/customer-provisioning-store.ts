// customer-provisioning-store.ts · server-side customer onboarding provisioning.
//
// Authority: lifts scripts/onboard-customer.mjs + src/workers/db/seed/customer-template.sql
// (the proven, idempotent CLI seed) into a Worker-callable, transactional function so a
// customer's workspace/project/roadmap is provisioned from the app — no local psql/CLI.
//
// IDENTITY TIMING: the workspace id IS the Clerk org id and the owner is a Clerk user id, so
// this runs AFTER the Clerk org + user exist (post invite-accept) — exactly when the CLI ran.
// It is admin-triggered today (POST /admin/access-requests/:id/provision); a future variant can
// call provisionCustomerWorkspaceRow from the first authenticated session.
//
// IDEMPOTENT: every statement is ON CONFLICT — safe to re-run (operator double-click, retry).
// Mirrors customer-template.sql 1:1 so behaviour matches the prod-tested seed.

import { makeError } from './shared-helpers';
import { memberAuthorityProvisioningStatements } from './member-authority-provisioning';
import type { Sql } from '../db/client';

export interface ProvisionRoadmapStep {
  summary: string;
  body: string;
}

export interface ProvisionCustomerInput {
  /** Access request that caused provisioning; linked after the workspace row exists. */
  accessRequestId?: string | null;
  /** Clerk org id — becomes the workspace id (1:1 with the org). */
  clerkOrgId: string;
  customerName: string;
  customerSlug: string;
  /** Clerk user id of the workspace owner (must exist post invite-accept). */
  ownerClerkId: string;
  /** Clerk user id of the day-to-day operator; omit/equal-to-owner → owner only. */
  operatorClerkId?: string | null;
  projectName: string;
  /** Deterministic so re-runs don't create duplicate projects. */
  projectId: string;
  /** Admin (approver) user id, for audit. */
  approvedBy: string;
  /** Day-1 roadmap steps (built from the readiness Q&A); rendered as queued events. */
  roadmap: ProvisionRoadmapStep[];
}

export interface ProvisionCustomerResult {
  workspace_id: string;
  project_id: string;
  members: number;
  events_created: number;
  roadmap_steps: number;
}

/**
 * Provision (or re-provision, idempotently) a customer's workspace, owner/operator
 * membership, default project, welcome event, day-1 roadmap events, operator authority
 * consent, and audit log — in one transaction. Throws VALIDATION_ERROR on missing ids.
 */
export async function provisionCustomerWorkspaceRow(
  sql: Sql,
  input: ProvisionCustomerInput,
): Promise<ProvisionCustomerResult> {
  const orgId = (input.clerkOrgId || '').trim();
  const owner = (input.ownerClerkId || '').trim();
  if (!orgId || !owner) {
    throw makeError('VALIDATION_ERROR', 'clerkOrgId and ownerClerkId are required', 400);
  }
  if (!input.projectId || !input.projectName) {
    throw makeError('VALIDATION_ERROR', 'projectId and projectName are required', 400);
  }
  const name = input.customerName || orgId;
  const slug = (input.customerSlug || orgId).toLowerCase();
  const approvedBy = (input.approvedBy || owner).trim();
  // Operator only matters if distinct from owner (a same-id operator member would
  // demote the owner row owner->operator via ON CONFLICT — the CLI skips it too).
  const operator =
    input.operatorClerkId && input.operatorClerkId.trim() && input.operatorClerkId.trim() !== owner
      ? input.operatorClerkId.trim()
      : null;
  const roadmap = Array.isArray(input.roadmap) ? input.roadmap : [];

  const stmts: unknown[] = [
    // 1. Workspace (1:1 with the Clerk org).
    sql/*sql*/`
      INSERT INTO workspaces (id, name, owner_user_id, slug)
      VALUES (${orgId}, ${name}, ${owner}, ${slug})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, updated_at = now()
    `,
    // 2. Owner user (R40 — must be 'approved' for product access).
    sql/*sql*/`
      INSERT INTO users (id, status, approved_at, approved_by)
      VALUES (${owner}, 'approved', now(), ${approvedBy})
      ON CONFLICT (id) DO UPDATE SET status = 'approved',
        approved_at = COALESCE(users.approved_at, EXCLUDED.approved_at),
        approved_by = COALESCE(users.approved_by, EXCLUDED.approved_by), updated_at = now()
    `,
    // 2b. Approver user mirror. Auto-provisioning may be approved by an operator/system
    // user from env rather than the customer owner. customer_authority_consents has a
    // real FK to users(id), so the transaction must mirror the approver before that row.
    sql/*sql*/`
      INSERT INTO users (id, status, approved_at, approved_by)
      VALUES (${approvedBy}, 'approved', now(), ${approvedBy})
      ON CONFLICT (id) DO UPDATE SET status = 'approved',
        approved_at = COALESCE(users.approved_at, EXCLUDED.approved_at),
        approved_by = COALESCE(users.approved_by, EXCLUDED.approved_by), updated_at = now()
    `,
    // 3. Owner workspace member (active).
    sql/*sql*/`
      INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at, activated_by)
      VALUES (${orgId}, ${owner}, 'owner', 'active', now(), ${approvedBy})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner', status = 'active',
        activated_at = COALESCE(workspace_members.activated_at, EXCLUDED.activated_at),
        activated_by = COALESCE(workspace_members.activated_by, EXCLUDED.activated_by)
    `,
    // 3b. P5(a) §5e: entitlement + operating-mode axes provisioned in the SAME transaction as the membership.
    ...(memberAuthorityProvisioningStatements(sql, {
      userId: owner, workspaceId: orgId, role: 'owner', actorUserId: approvedBy,
    }) as never[]),
    // 6. Operator authority (provisioning IS the operator's DR-11 approval; customer still acks in-app).
    sql/*sql*/`
      INSERT INTO customer_authority_consents (id, workspace_id, access_request_id, operator_approved_at, operator_approved_by)
      VALUES ('auth_' || replace(gen_random_uuid()::text, '-', ''), ${orgId}, ${input.accessRequestId ?? null}, now(), ${approvedBy})
      ON CONFLICT (workspace_id) WHERE revoked_at IS NULL
      DO UPDATE SET operator_approved_at = now(),
        operator_approved_by = EXCLUDED.operator_approved_by,
        access_request_id = COALESCE(EXCLUDED.access_request_id, customer_authority_consents.access_request_id),
        updated_at = now()
    `,
    // 7. Default project (deterministic id → idempotent).
    sql/*sql*/`
      INSERT INTO projects (id, workspace_id, name, status)
      VALUES (${input.projectId}, ${orgId}, ${input.projectName}, 'active')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now()
    `,
    // 8. Welcome event (first-login stream).
    sql/*sql*/`
      INSERT INTO operation_events (id, workspace_id, project_id, source_tool, status, summary, body, visibility, occurred_at)
      VALUES (${'evt_welcome_' + slug}, ${orgId}, ${input.projectId}, 'operator', 'completed',
        'Workspace provisioned · welcome to Xlooop',
        'Your Xlooop workspace is live. Events from your operations will stream here automatically.',
        'internal_workspace', now())
      ON CONFLICT (id) DO NOTHING
    `,
    // 9. Audit (workspace_create + owner activate).
    sql/*sql*/`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id, reason)
      VALUES (${approvedBy}, 'workspace_create', 'workspace', ${orgId}, ${orgId}, 'server-side provision'),
             (${approvedBy}, 'member_activate', 'workspace_member', ${owner}, ${orgId}, 'server-side provision · owner')
    `,
  ];

  if (input.accessRequestId) {
    stmts.push(
      sql/*sql*/`
        UPDATE access_requests
        SET invited_to_workspace_id = ${orgId},
            user_id = COALESCE(user_id, ${owner}),
            updated_at = now()
        WHERE id = ${input.accessRequestId}
      `,
      // S1 (260628) · stamp the readiness assessment with the workspace id so the captured company
      // context is recoverable BY WORKSPACE (the cockpit chat + MCP get_effective_profile only hold
      // workspace_id). Without this, readiness_assessments.workspace_id stays NULL and the context is
      // a write-only silo. Idempotent.
      sql/*sql*/`
        UPDATE readiness_assessments SET workspace_id = ${orgId}, updated_at = now()
        WHERE access_request_id = ${input.accessRequestId}
      `,
    );
  }

  if (operator) {
    stmts.push(
      sql/*sql*/`
        INSERT INTO users (id, status, approved_at, approved_by)
        VALUES (${operator}, 'approved', now(), ${approvedBy})
        ON CONFLICT (id) DO UPDATE SET status = 'approved',
          approved_at = COALESCE(users.approved_at, EXCLUDED.approved_at),
          approved_by = COALESCE(users.approved_by, EXCLUDED.approved_by), updated_at = now()
      `,
      sql/*sql*/`
        INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at, activated_by)
        VALUES (${orgId}, ${operator}, 'operator', 'active', now(), ${approvedBy})
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'operator', status = 'active',
          activated_at = COALESCE(workspace_members.activated_at, EXCLUDED.activated_at),
          activated_by = COALESCE(workspace_members.activated_by, EXCLUDED.activated_by)
      `,
      // P5(a) §5e: entitlement + operating-mode axes for the operator member, same transaction.
      ...(memberAuthorityProvisioningStatements(sql, {
        userId: operator, workspaceId: orgId, role: 'operator', actorUserId: approvedBy,
      }) as never[]),
    );
  }

  // Day-1 roadmap → queued operation_events (deterministic ids; occurred a minute apart).
  // F1 (260628): the ON CONFLICT below is status-PRESERVING — a re-provision (a customer
  // re-running the readiness journey from Profile to "update my roadmap") refreshes the
  // content (summary/body) from the new answers but must NOT clobber a step the customer
  // already marked done. `status` is therefore omitted from the DO UPDATE (the existing
  // row keeps its status; the first INSERT still seeds 'queued'). Re-entry safety.
  roadmap.forEach((step, i) => {
    const id = `evt_${slug}_roadmap_${String(i + 1).padStart(2, '0')}`;
    stmts.push(
      sql/*sql*/`
        INSERT INTO operation_events (id, workspace_id, project_id, source_tool, status, summary, body, visibility, occurred_at)
        VALUES (${id}, ${orgId}, ${input.projectId}, 'xlooop', 'queued', ${step.summary}, ${step.body},
          'internal_workspace', now() + (interval '1 minute' * ${i + 1}))
        ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary, body = EXCLUDED.body
      `,
    );
  });

  await (sql as unknown as { transaction: (q: unknown[]) => Promise<unknown> }).transaction(stmts);

  return {
    workspace_id: orgId,
    project_id: input.projectId,
    members: operator ? 2 : 1,
    events_created: 1 + roadmap.length,
    roadmap_steps: roadmap.length,
  };
}
