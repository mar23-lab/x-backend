// member-authority-provisioning.test.ts · P5(a) (260708) · the standing §5e provisioning writer.
// Proves the role-mirror stays in LOCKSTEP with 055/056 semantics in BOTH directions: creation/promotion
// seeds operator-grade entitlement + operator mode (no-clobber); demotion re-mirrors the entitlement DOWN
// and forces watch mode (a demotion that left operator authority behind would be the data-axis twin of the
// enabled→403 affordance lie). Degrade-safe: provisioning failure never breaks the member write.

import { describe, it, expect, vi } from 'vitest';
import {
  roleMirrorEntitlement,
  memberAuthorityProvisioningStatements,
  ensureMemberAuthorityProvisioned,
} from '../dal/member-authority-provisioning';

// Mock tagged-template Sql: captures (sqlText, values) per call; each statement is a resolved thenable.
function captureSql() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve([]);
  }) as never;
  return { sql, calls };
}

describe('roleMirrorEntitlement · 055 SSOT lockstep', () => {
  it('owner/operator → operator-grade grant', () => {
    for (const role of ['owner', 'operator']) {
      expect(roleMirrorEntitlement(role)).toEqual({
        allowed_modes: ['watch', 'test', 'operator'], allowed_actions: ['*'], denied_actions: [],
      });
    }
  });
  it('viewer → watch-only, no actions', () => {
    expect(roleMirrorEntitlement('viewer')).toEqual({ allowed_modes: ['watch'], allowed_actions: [], denied_actions: [] });
  });
  it('client → watch-only + denied [*] (deny-wins)', () => {
    expect(roleMirrorEntitlement('client')).toEqual({ allowed_modes: ['watch'], allowed_actions: [], denied_actions: ['*'] });
  });
});

describe('memberAuthorityProvisioningStatements', () => {
  it('owner → entitlement UPSERT (re-mirror on conflict) + operator-mode seed that NEVER clobbers', () => {
    const { sql, calls } = captureSql();
    const stmts = memberAuthorityProvisioningStatements(sql, { userId: 'u1', workspaceId: 'w1', role: 'owner', actorUserId: 'admin' });
    expect(stmts).toHaveLength(2);
    expect(calls[0].text).toContain('INSERT INTO customer_entitlements');
    expect(calls[0].text).toContain('ON CONFLICT (user_id, workspace_id, app_id) DO UPDATE');
    expect(calls[0].values).toContain('u1');
    expect(calls[0].values).toContain('admin'); // granted_by = actor
    expect(calls[0].values).toContainEqual(['watch', 'test', 'operator']);
    expect(calls[1].text).toContain('INSERT INTO user_session_preferences');
    expect(calls[1].text).toContain('DO NOTHING'); // 056 semantics: never clobber an explicit user mode
    expect(calls[1].text).toContain("'operator'"); // mode is a SQL literal in the statement text
  });

  it('DEMOTION (viewer) → entitlement re-mirrored DOWN + mode FORCED to watch', () => {
    const { sql, calls } = captureSql();
    memberAuthorityProvisioningStatements(sql, { userId: 'u1', workspaceId: 'w1', role: 'viewer', actorUserId: 'admin' });
    expect(calls[0].values).toContainEqual(['watch']); // allowed_modes downgraded
    expect(calls[0].values).toContainEqual([]);        // actions emptied
    expect(calls[1].text).toContain("DO UPDATE SET operating_mode = 'watch'"); // demote clobbers TO watch
  });

  it('client → denied_actions [*] rides the entitlement statement (deny-wins survives)', () => {
    const { sql, calls } = captureSql();
    memberAuthorityProvisioningStatements(sql, { userId: 'u1', workspaceId: 'w1', role: 'client' });
    expect(calls[0].values).toContainEqual(['*']); // denied_actions
  });

  it('granted_by falls back to the member when no actor', () => {
    const { sql, calls } = captureSql();
    memberAuthorityProvisioningStatements(sql, { userId: 'u9', workspaceId: 'w1', role: 'operator' });
    expect(calls[0].values.filter((v) => v === 'u9').length).toBeGreaterThanOrEqual(2); // user_id + granted_by
  });
});

describe('ensureMemberAuthorityProvisioned · degrade-safe', () => {
  it('a throwing sql NEVER propagates (member write must not break) and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = (() => Promise.reject(new Error('relation customer_entitlements does not exist'))) as never;
    await expect(
      ensureMemberAuthorityProvisioned(sql, { userId: 'u1', workspaceId: 'w1', role: 'owner' }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('member_authority_provisioning.failed');
    warn.mockRestore();
  });

  it('happy path awaits both statements', async () => {
    const { sql, calls } = captureSql();
    await ensureMemberAuthorityProvisioned(sql, { userId: 'u1', workspaceId: 'w1', role: 'operator' });
    expect(calls).toHaveLength(2);
  });
});
