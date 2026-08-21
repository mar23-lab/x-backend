import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { workspaceRelationshipRoute } from '../routes/workspace-relationship';
import type { Sql } from '../db/client';
import { transitionWorkspaceRelationshipStatusRow } from '../dal/workspace-relationship-store';

function appFor(auth: Record<string, unknown> | null, dal: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'req_test');
    if (auth) ctx.set('auth', auth as never);
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1/admin', workspaceRelationshipRoute as never);
  return app;
}

const command = {
  relationship_status: 'pilot_candidate',
  expected_current_status: 'archived',
  reason: 'Owner-approved recovery after unaudited archive classification.',
};

describe('workspace relationship lifecycle authority', () => {
  it('fails closed without an authenticated admin', async () => {
    const transition = vi.fn();
    const res = await appFor(null, { transitionWorkspaceRelationshipStatus: transition }).request(
      '/api/v1/admin/workspaces/org_customer/relationship-status',
      { method: 'POST', body: JSON.stringify(command), headers: { 'content-type': 'application/json' } },
    );
    expect(res.status).toBe(403);
    expect(transition).not.toHaveBeenCalled();
  });

  it('fails closed for a non-admin workspace owner', async () => {
    const transition = vi.fn();
    const res = await appFor(
      { user_id: 'user_owner', role: 'owner', is_admin: false },
      { transitionWorkspaceRelationshipStatus: transition },
    ).request('/api/v1/admin/workspaces/org_customer/relationship-status', {
      method: 'POST', body: JSON.stringify(command), headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
    expect(transition).not.toHaveBeenCalled();
  });

  it('rejects unregistered states before the DAL', async () => {
    const transition = vi.fn();
    const res = await appFor(
      { user_id: 'user_admin', role: 'operator', is_admin: true },
      { transitionWorkspaceRelationshipStatus: transition },
    ).request('/api/v1/admin/workspaces/org_customer/relationship-status', {
      method: 'POST',
      body: JSON.stringify({ ...command, relationship_status: 'public_self_serve_magic' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(transition).not.toHaveBeenCalled();
  });

  it('returns a durable receipt for an admin transition', async () => {
    const transition = vi.fn(async () => ({
      workspace_id: 'org_customer',
      previous_status: 'archived',
      relationship_status: 'pilot_candidate',
      audit_id: '17299',
      occurred_at: '2026-08-21T05:00:00Z',
    }));
    const res = await appFor(
      { user_id: 'user_admin', role: 'operator', is_admin: true },
      { transitionWorkspaceRelationshipStatus: transition },
    ).request('/api/v1/admin/workspaces/org_customer/relationship-status', {
      method: 'POST', body: JSON.stringify(command), headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(transition).toHaveBeenCalledWith('org_customer', {
      relationship_status: 'pilot_candidate',
      expected_current_status: 'archived',
      actor_user_id: 'user_admin',
      request_id: 'req_test',
      reason: command.reason,
    });
    const body = await res.json() as { _meta: { authority: string }; receipt: { audit_id: string } };
    expect(body._meta.authority).toBe('platform_admin_only');
    expect(body.receipt.audit_id).toBe('17299');
  });
});

describe('workspace relationship lifecycle store', () => {
  function sqlReturning(rows: unknown[]) {
    return vi.fn(async () => rows) as unknown as Sql;
  }

  it('validates the target workspace and reason before SQL execution', async () => {
    const sql = sqlReturning([]);
    await expect(transitionWorkspaceRelationshipStatusRow(sql, '', {
      ...command,
      actor_user_id: 'user_admin',
      request_id: 'req_test',
    })).rejects.toMatchObject({ status: 400 });
    expect(sql).not.toHaveBeenCalled();
  });

  it('returns not found when the workspace does not exist', async () => {
    await expect(transitionWorkspaceRelationshipStatusRow(sqlReturning([]), 'org_missing', {
      ...command,
      actor_user_id: 'user_admin',
      request_id: 'req_test',
    })).rejects.toMatchObject({ status: 404 });
  });

  it('fails on an optimistic-concurrency conflict without inventing a receipt', async () => {
    await expect(transitionWorkspaceRelationshipStatusRow(sqlReturning([{
      workspace_id: 'org_customer',
      previous_status: 'customer_active',
      relationship_status: null,
      audit_id: null,
      occurred_at: null,
    }]), 'org_customer', {
      ...command,
      actor_user_id: 'user_admin',
      request_id: 'req_test',
    })).rejects.toMatchObject({ status: 409 });
  });

  it('maps the atomic update and audit row to a durable receipt', async () => {
    const receipt = await transitionWorkspaceRelationshipStatusRow(sqlReturning([{
      workspace_id: 'org_customer',
      previous_status: 'archived',
      relationship_status: 'pilot_candidate',
      audit_id: '17299',
      occurred_at: '2026-08-21T05:00:00Z',
    }]), 'org_customer', {
      ...command,
      actor_user_id: 'user_admin',
      request_id: 'req_test',
    });
    expect(receipt).toEqual({
      workspace_id: 'org_customer',
      previous_status: 'archived',
      relationship_status: 'pilot_candidate',
      audit_id: '17299',
      occurred_at: '2026-08-21T05:00:00Z',
    });
  });
});
