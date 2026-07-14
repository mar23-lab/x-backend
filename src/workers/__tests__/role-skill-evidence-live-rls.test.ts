// role-skill-evidence-live-rls.test.ts · Track A (260713)
//
// Live Neon-branch proof that DB-layer RLS — not just the app-side WHERE discipline — fences the
// mig-070 evidence tables. Runs only when XLOOOP_RUN_LIVE_RLS=1 and DATABASE_URL targets a DISPOSABLE
// Neon branch with the amended 070 applied. Cloned from operational-spine-live-rls.test.ts with the
// two activation-readiness gap-fixes:
//   (1) the probe role gets GRANT SELECT on the evidence tables (070 grants xlooop_app; the probe
//       mirrors that role's shape: LOGIN, non-superuser, NOBYPASSRLS-by-default);
//   (2) the probe SELECTs carry NO workspace predicate — with the GUC set to A only A's rows may
//       appear, and with NO GUC set zero rows may appear. This isolates the DB layer: an app-WHERE
//       cannot be what filtered the result, because there is no WHERE.
// Writes are seeded through the OWNER connection on purpose — that is the production write plane
// (the shadow observer is owner-connected by design; see the Track A evidence doc).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { neonClient, type Sql } from '../db/client';
import { withWorkspaceRlsContext } from '../dal/operational-spine-store';

const liveEnv = env as { XLOOOP_RUN_LIVE_RLS?: string; DATABASE_URL?: string };
const shouldRun = liveEnv.XLOOOP_RUN_LIVE_RLS === '1' && !!liveEnv.DATABASE_URL;
const describeLive = shouldRun ? describe : describe.skip;

const ROLE = `xlooop_evidence_rls_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const WS_A = 'ev_rls_live_ws_a';
const WS_B = 'ev_rls_live_ws_b';
const RES_A = 'rsr_ev_rls_live_a';
const RES_B = 'rsr_ev_rls_live_b';
const DEN_A = 'adr_ev_rls_live_a';
const DEN_B = 'adr_ev_rls_live_b';
const SHA = 'a'.repeat(64);

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function sqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function cleanup(ownerSql: Sql) {
  await ownerSql`DELETE FROM role_skill_resolutions WHERE id IN (${RES_A}, ${RES_B})`;
  await ownerSql`DELETE FROM authority_denial_receipts WHERE id IN (${DEN_A}, ${DEN_B})`;
  await ownerSql(`REVOKE ALL ON role_skill_resolutions FROM ${sqlIdentifier(ROLE)}`).catch(() => undefined);
  await ownerSql(`REVOKE ALL ON authority_denial_receipts FROM ${sqlIdentifier(ROLE)}`).catch(() => undefined);
  await ownerSql(`REVOKE ALL ON SCHEMA public FROM ${sqlIdentifier(ROLE)}`).catch(() => undefined);
  await ownerSql(`DROP ROLE IF EXISTS ${sqlIdentifier(ROLE)}`);
}

describeLive('role-skill evidence plane live RLS proof (mig 070)', () => {
  let ownerSql: Sql;
  let probeSql: Sql;

  beforeAll(async () => {
    ownerSql = neonClient(liveEnv.DATABASE_URL);
    await cleanup(ownerSql).catch(() => undefined);

    // probe role: LOGIN + non-bypass (the xlooop_app shape); SELECT-only on the evidence tables —
    // exactly the 070 grant. EXECUTE on the GUC reader comes via PUBLIC default for SQL functions.
    const password = `xlooop-${randomUUID()}-${randomUUID()}`;
    await ownerSql(`CREATE ROLE ${sqlIdentifier(ROLE)} LOGIN PASSWORD ${sqlLiteral(password)} NOBYPASSRLS`);
    await ownerSql(`GRANT USAGE ON SCHEMA public TO ${sqlIdentifier(ROLE)}`);
    await ownerSql(`GRANT SELECT ON role_skill_resolutions TO ${sqlIdentifier(ROLE)}`);
    await ownerSql(`GRANT SELECT ON authority_denial_receipts TO ${sqlIdentifier(ROLE)}`);

    // owner-plane seed (the production write plane): one resolution + one denial per workspace
    await ownerSql`
      INSERT INTO role_skill_resolutions (id, workspace_id, principal_id, role_key, action, mode,
        skill_coverage, resolver_verdict, resolver_allowed, actual_reason, actual_allowed, agreement,
        content_sha256, resolver_source, expires_at)
      VALUES
        (${RES_A}, ${WS_A}, 'u_a', 'operator', 'packet:create', 'operator', 'no_catalog',
         'skill_not_installed', false, 'active_entitlement', true, 'resolver_stricter', ${SHA}, 'v0-floor', now() + interval '15 min'),
        (${RES_B}, ${WS_B}, 'u_b', 'operator', 'packet:create', 'operator', 'no_catalog',
         'skill_not_installed', false, 'active_entitlement', true, 'resolver_stricter', ${SHA}, 'v0-floor', now() + interval '15 min')
    `;
    await ownerSql`
      INSERT INTO authority_denial_receipts (id, workspace_id, principal_id, role_key, action, mode,
        denied_by, safe_explanation, content_sha256)
      VALUES
        (${DEN_A}, ${WS_A}, 'u_a', 'operator', 'packet:create', 'operator', 'entitlement', 'safe A', ${SHA}),
        (${DEN_B}, ${WS_B}, 'u_b', 'operator', 'packet:create', 'operator', 'entitlement', 'safe B', ${SHA})
    `;

    const probeUrl = new URL(liveEnv.DATABASE_URL!);
    probeUrl.username = ROLE;
    probeUrl.password = password;
    probeSql = neonClient(probeUrl.toString());
  });

  afterAll(async () => {
    if (ownerSql) await cleanup(ownerSql).catch(() => undefined);
  });

  it('owner (write plane) bypasses RLS — sees both workspaces with no predicate', async () => {
    // honest acknowledgment of the topology: the owner IS bypass; that is why writes work flag-on.
    const rows = (await ownerSql`SELECT id FROM role_skill_resolutions WHERE id IN (${RES_A}, ${RES_B})`) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual([RES_A, RES_B]);
  });

  it('probe role + GUC=A sees ONLY workspace A rows with NO workspace predicate (DB-layer RLS)', async () => {
    const [resolutions, denials] = await withWorkspaceRlsContext<[Array<{ id: string }>, Array<{ id: string }>]>(
      probeSql,
      WS_A,
      (tx) => [
        tx/*sql*/`SELECT id FROM role_skill_resolutions WHERE id IN (${RES_A}, ${RES_B})`,
        tx/*sql*/`SELECT id FROM authority_denial_receipts WHERE id IN (${DEN_A}, ${DEN_B})`,
      ],
      { readOnly: true },
    );
    expect(resolutions.map((r) => r.id)).toEqual([RES_A]); // B invisible — RLS, not an app-WHERE
    expect(denials.map((r) => r.id)).toEqual([DEN_A]);
  });

  it('probe role + GUC=B sees ONLY workspace B rows', async () => {
    const [resolutions] = await withWorkspaceRlsContext<[Array<{ id: string }>]>(
      probeSql,
      WS_B,
      (tx) => [tx/*sql*/`SELECT id FROM role_skill_resolutions WHERE id IN (${RES_A}, ${RES_B})`],
      { readOnly: true },
    );
    expect(resolutions.map((r) => r.id)).toEqual([RES_B]);
  });

  it('probe role with NO GUC set sees ZERO rows (fail-closed: unset GUC matches nothing)', async () => {
    const rows = (await probeSql`SELECT id FROM role_skill_resolutions WHERE id IN (${RES_A}, ${RES_B})`) as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });

  it('probe role cannot INSERT (SELECT-only grant, mirroring xlooop_app)', async () => {
    await expect(
      probeSql`
        INSERT INTO role_skill_resolutions (id, workspace_id, principal_id, role_key, action, mode,
          skill_coverage, resolver_verdict, resolver_allowed, actual_reason, actual_allowed, agreement,
          content_sha256, expires_at)
        VALUES ('rsr_probe_denied', ${WS_A}, 'u_x', 'operator', 'packet:create', 'operator', 'no_catalog',
          'skill_not_installed', false, 'x', true, 'agree', ${SHA}, now())
      `,
    ).rejects.toThrow(/permission denied/i);
  });
});
