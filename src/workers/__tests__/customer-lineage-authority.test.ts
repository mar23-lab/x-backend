// customer-lineage-authority.test.ts · U2 (260708) · within-workspace governance gate for the lineage read.
// DECLARED AXES: actors [owner · operator · viewer · client · no-workspace · unprovisioned] ·
// surfaces [/customer-lineage · /customer-graph-digest] · leak-shape [owner-only descriptions never reach a
// non-owner-class caller because the whole surface 403s before the read].
//
// WHY: getArtefactLineageRow reads v_artefact_lineage WHERE workspace_id=... with NO role/visibility filter —
// it returns every edge's from_description/to_description in the workspace. Gating on provisioning alone would
// let a viewer/client walk owner-only lineage. This locks the owner/operator-class gate (flag-off ≡ canWrite).

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { customerLineageRoute } from '../routes/customer-lineage';

const PROVISIONED = { getSessionEntitlement: async () => ({ state: 'approved_workspace' }) };
// If the gate ever regressed, these owner-only descriptions would surface to a viewer/client — the leak we bar.
const LINEAGE = {
  getSessionEntitlement: PROVISIONED.getSessionEntitlement,
  getArtefactLineage: async () => ([
    { edge_from: 'event:e1', from_type: 'event', from_description: 'OWNER-ONLY board note', edge_to: 'intent:i1', to_type: 'intent', to_description: 'confidential intent', edge_type: 'realizes', is_cause_edge: true },
  ]),
  assembleDataGraphFacts: async () => ({ workspace: { id: 'ws-MINE', name: 'x' }, projects: [], events: [], intents: [], packets: [], evidence: [], documents: [] }),
};

function appFor(auth: Record<string, unknown>, dal: Record<string, unknown>, env: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 't'); ctx.set('auth', auth as never); ctx.set('dal', dal as never);
    await next();
  });
  app.route('/', customerLineageRoute as never);
  return { app, env: { DATABASE_URL: 'postgres://fake@h/d', ...env } as never };
}

describe('GET /customer-lineage · owner/operator-class governance gate (flag off)', () => {
  for (const role of ['owner', 'operator']) {
    it(`${role} → 200 with the lineage edges`, async () => {
      const { app, env } = appFor({ user_id: 'u1', workspace_id: 'ws-MINE', role }, LINEAGE, { ENTITLEMENT_ENFORCEMENT: 'off' });
      const res = await app.request('/customer-lineage', {}, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { edge_count: number };
      expect(body.edge_count).toBe(1);
    });
  }

  for (const role of ['viewer', 'client']) {
    it(`${role} → 403 BEFORE any lineage read (owner-only descriptions never reach them)`, async () => {
      let lineageRead = false;
      const dal = { ...LINEAGE, getArtefactLineage: async () => { lineageRead = true; return []; } };
      const { app, env } = appFor({ user_id: 'v1', workspace_id: 'ws-MINE', role }, dal, { ENTITLEMENT_ENFORCEMENT: 'off' });
      const res = await app.request('/customer-lineage', {}, env);
      expect(res.status).toBe(403);
      expect(lineageRead).toBe(false); // gate fires before the read — no leak surface
      expect(JSON.stringify(await res.json())).not.toContain('OWNER-ONLY'); // and nothing leaked in the error
    });
  }

  it('no signed-in workspace → 403', async () => {
    const { app, env } = appFor({ user_id: 'u1', workspace_id: '', role: 'owner' }, LINEAGE);
    const res = await app.request('/customer-lineage', {}, env);
    expect(res.status).toBe(403);
  });

  it('unprovisioned workspace → 403 (provisioning still checked first)', async () => {
    const dal = { ...LINEAGE, getSessionEntitlement: async () => ({ state: 'pending' }) };
    const { app, env } = appFor({ user_id: 'u1', workspace_id: 'ws-MINE', role: 'owner' }, dal);
    const res = await app.request('/customer-lineage', {}, env);
    expect(res.status).toBe(403);
  });
});

describe('GET /customer-graph-digest · same governance gate', () => {
  it('viewer → 403; owner → 200', async () => {
    const v = appFor({ user_id: 'v1', workspace_id: 'ws-MINE', role: 'viewer' }, LINEAGE, { ENTITLEMENT_ENFORCEMENT: 'off' });
    expect((await v.app.request('/customer-graph-digest', {}, v.env)).status).toBe(403);
    const o = appFor({ user_id: 'u1', workspace_id: 'ws-MINE', role: 'owner' }, LINEAGE, { ENTITLEMENT_ENFORCEMENT: 'off' });
    expect((await o.app.request('/customer-graph-digest', {}, o.env)).status).toBe(200);
  });
});
