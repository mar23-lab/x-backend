// synthetic-domain-goal-status-alias.test.ts · W2 R3 (audit gap G7 regression)
// The goal PATCH route accepted the completion aliases done/completed (the shadow-policy
// block explicitly recognises them) but passed body.status through RAW to dal.updateGoal,
// while the DB CHECK (006:101) admits only proposed|active|achieved|abandoned — so an
// alias reaching the DAL was a latent constraint violation. These tests lock that the
// route now normalises aliases AT THE EDGE and never widens the DB vocabulary:
//   (1) done      -> achieved before the DAL sees it,
//   (2) completed -> achieved before the DAL sees it,
//   (3) canonical values pass through untouched.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { syntheticDomainsRoute } from '../routes/synthetic-domains';

const OPERATOR = { user_id: 'user_op', role: 'operator', workspace_id: 'me' };

// Captures what the route hands to the DAL so we can assert the alias never crosses the edge.
let captured: any = null;
function mockDal() {
  return {
    updateGoal: async (goalId: string, patch: any, _uid: string) => {
      captured = { goalId, patch };
      return { id: goalId, status: patch.status };
    },
  };
}

function appFor(auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', mockDal() as never);
    await next();
  });
  app.route('/api/v1', syntheticDomainsRoute);
  return app;
}

const patchGoal = (auth: Record<string, unknown>, bodyObj: unknown) =>
  appFor(auth).request('/api/v1/synthetic-domain-goals/g_test', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });

describe('goal PATCH — completion-alias normalisation at the route edge (G7)', () => {
  it('maps status done -> achieved before the DAL', async () => {
    captured = null;
    const res = await patchGoal(OPERATOR, { status: 'done' });
    expect(res.status).toBe(200);
    expect(captured.patch.status).toBe('achieved');
  });

  it('maps status completed -> achieved before the DAL', async () => {
    captured = null;
    const res = await patchGoal(OPERATOR, { status: 'completed' });
    expect(res.status).toBe(200);
    expect(captured.patch.status).toBe('achieved');
  });

  it('passes canonical statuses through untouched', async () => {
    for (const status of ['proposed', 'active', 'achieved', 'abandoned']) {
      captured = null;
      const res = await patchGoal(OPERATOR, { status });
      expect(res.status).toBe(200);
      expect(captured.patch.status).toBe(status);
    }
  });
});
