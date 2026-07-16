// operational-spine-live-rls.test.ts
//
// Live Neon branch proof for route -> WorkersDalAdapter -> Postgres RLS.
// Runs only when XLOOOP_RUN_LIVE_RLS=1 and DATABASE_URL targets a disposable
// Neon branch. It creates a temporary non-bypass role and branch-only probe
// rows, then removes them.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { neonClient, type Sql } from '../db/client';
import { WorkersDalAdapter } from '../dal/WorkersDalAdapter';
import { operationalSpineRoute } from '../routes/operational-spine';

const liveEnv = env as { XLOOOP_RUN_LIVE_RLS?: string; DATABASE_URL?: string };
const liveGateRequested = liveEnv.XLOOOP_RUN_LIVE_RLS === '1';
const databaseUrl = liveEnv.DATABASE_URL || '';
const shouldRun = liveGateRequested && !!databaseUrl;
const describeLive = shouldRun ? describe : describe.skip;

if (liveGateRequested && !databaseUrl) {
  describe('operational spine live RLS prerequisite gate', () => {
    it('fails closed when XLOOOP_RUN_LIVE_RLS=1 is set without DATABASE_URL', () => {
      throw new Error('DATABASE_URL is required for live RLS proof; skipped live-RLS runs cannot satisfy acceptance.');
    });
  });
}

const ROLE = `xlooop_rls_live_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const WORKSPACE_A = 'rls_live_ws_a';
const WORKSPACE_B = 'rls_live_ws_b';
const PACKET_A = 'rls_live_packet_a';
const PACKET_B = 'rls_live_packet_b';
const EVIDENCE_A = 'rls_live_evidence_a';
const EVIDENCE_B = 'rls_live_evidence_b';
const APPROVAL_A = 'rls_live_approval_a';
const APPROVAL_B = 'rls_live_approval_b';
const TOOL_EVENT_A = 'rls_live_tool_event_a';
const TOOL_EVENT_B = 'rls_live_tool_event_b';
const METRIC_DELTA_A = 'rls_live_metric_delta_a';
const METRIC_DELTA_B = 'rls_live_metric_delta_b';

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function appFor(sql: Sql, auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'live-rls-test');
    ctx.set('auth', auth as never);
    ctx.set('dal', new WorkersDalAdapter(sql) as never);
    await next();
  });
  app.route('/api/v1', operationalSpineRoute);
  return app;
}

async function expectStatus(response: Response, expected: number) {
  if (response.status !== expected) {
    throw new Error(`expected HTTP ${expected}, got ${response.status}: ${await response.text()}`);
  }
}

async function cleanup(ownerSql: Sql) {
  await ownerSql`DELETE FROM metric_deltas WHERE id IN (${METRIC_DELTA_A}, ${METRIC_DELTA_B})`;
  await ownerSql`DELETE FROM tool_events WHERE id IN (${TOOL_EVENT_A}, ${TOOL_EVENT_B})`;
  await ownerSql`DELETE FROM approval_requests WHERE id IN (${APPROVAL_A}, ${APPROVAL_B})`;
  await ownerSql`DELETE FROM evidence_items WHERE id IN (${EVIDENCE_A}, ${EVIDENCE_B})`;
  await ownerSql`DELETE FROM task_packets WHERE id IN (${PACKET_A}, ${PACKET_B})`;
  await ownerSql`DELETE FROM workspaces WHERE id IN (${WORKSPACE_A}, ${WORKSPACE_B})`;
  await ownerSql(`REVOKE ALL ON metric_deltas FROM ${sqlIdentifier(ROLE)}`);
  await ownerSql(`REVOKE ALL ON tool_events FROM ${sqlIdentifier(ROLE)}`);
  await ownerSql(`REVOKE ALL ON approval_requests FROM ${sqlIdentifier(ROLE)}`);
  await ownerSql(`REVOKE ALL ON evidence_items FROM ${sqlIdentifier(ROLE)}`);
  await ownerSql(`REVOKE ALL ON task_packets FROM ${sqlIdentifier(ROLE)}`);
  await ownerSql(`REVOKE ALL ON SCHEMA public FROM ${sqlIdentifier(ROLE)}`);
  await ownerSql(`DROP ROLE IF EXISTS ${sqlIdentifier(ROLE)}`);
}

describeLive('operational spine live RLS route proof', () => {
  let ownerSql: Sql;
  let probeSql: Sql;

  beforeAll(async () => {
    ownerSql = neonClient(databaseUrl);
    await cleanup(ownerSql).catch(() => undefined);

    const password = `xlooop-${randomUUID()}-${randomUUID()}`;
    await ownerSql(`CREATE ROLE ${sqlIdentifier(ROLE)} LOGIN PASSWORD ${sqlLiteral(password)}`);
    await ownerSql(`GRANT USAGE ON SCHEMA public TO ${sqlIdentifier(ROLE)}`);
    await ownerSql(`GRANT SELECT, INSERT, UPDATE ON task_packets TO ${sqlIdentifier(ROLE)}`);
    await ownerSql(`GRANT SELECT, INSERT, UPDATE ON evidence_items TO ${sqlIdentifier(ROLE)}`);
    await ownerSql(`GRANT SELECT, INSERT, UPDATE ON approval_requests TO ${sqlIdentifier(ROLE)}`);
    await ownerSql(`GRANT SELECT, INSERT, UPDATE ON tool_events TO ${sqlIdentifier(ROLE)}`);
    await ownerSql(`GRANT SELECT, INSERT, UPDATE ON metric_deltas TO ${sqlIdentifier(ROLE)}`);
    await ownerSql`
      INSERT INTO workspaces(id, name, owner_user_id, slug)
      VALUES
        (${WORKSPACE_A}, 'RLS Live Probe A', 'rls_live_owner', 'rls-live-a'),
        (${WORKSPACE_B}, 'RLS Live Probe B', 'rls_live_owner', 'rls-live-b')
    `;

    const probeUrl = new URL(databaseUrl);
    probeUrl.username = ROLE;
    probeUrl.password = password;
    probeSql = neonClient(probeUrl.toString());
  });

  afterAll(async () => {
    if (ownerSql) await cleanup(ownerSql).catch(() => undefined);
  });

  it('creates and reads operational spine rows only through the request workspace context', async () => {
    const appA = appFor(probeSql, { user_id: 'user_a', role: 'operator', workspace_id: WORKSPACE_A });
    const appB = appFor(probeSql, { user_id: 'user_b', role: 'operator', workspace_id: WORKSPACE_B });

    const createA = await appA.request('/api/v1/packets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: PACKET_A, title: 'A', summary: 'workspace A packet' }),
    });
    await expectStatus(createA, 201);

    const createB = await appB.request('/api/v1/packets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: PACKET_B, title: 'B', summary: 'workspace B packet' }),
    });
    await expectStatus(createB, 201);

    const createEvidenceA = await appA.request('/api/v1/evidence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: EVIDENCE_A,
        packet_id: PACKET_A,
        kind: 'link',
        title: 'Evidence A',
        uri: 'https://example.com/a',
      }),
    });
    await expectStatus(createEvidenceA, 201);

    const createEvidenceB = await appB.request('/api/v1/evidence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: EVIDENCE_B,
        packet_id: PACKET_B,
        kind: 'link',
        title: 'Evidence B',
        uri: 'https://example.com/b',
      }),
    });
    await expectStatus(createEvidenceB, 201);

    const createApprovalA = await appA.request('/api/v1/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: APPROVAL_A, packet_id: PACKET_A, reason: 'approve A' }),
    });
    await expectStatus(createApprovalA, 201);

    const createApprovalB = await appB.request('/api/v1/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: APPROVAL_B, packet_id: PACKET_B, reason: 'approve B' }),
    });
    await expectStatus(createApprovalB, 201);

    const createToolEventA = await appA.request('/api/v1/tool-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: TOOL_EVENT_A,
        packet_id: PACKET_A,
        tool_name: 'xlooop.report_tool_event',
        action: 'report_tool_event',
        status: 'completed',
        evidence_item_id: EVIDENCE_A,
        summary: 'tool A',
      }),
    });
    await expectStatus(createToolEventA, 201);

    const createToolEventB = await appB.request('/api/v1/tool-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: TOOL_EVENT_B,
        packet_id: PACKET_B,
        tool_name: 'xlooop.report_tool_event',
        action: 'report_tool_event',
        status: 'completed',
        evidence_item_id: EVIDENCE_B,
        summary: 'tool B',
      }),
    });
    await expectStatus(createToolEventB, 201);

    const createMetricDeltaA = await appA.request('/api/v1/metric-deltas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: METRIC_DELTA_A,
        packet_id: PACKET_A,
        metric_id: 'rls.live.metric',
        before_value: 1,
        after_value: 2,
        evidence_item_id: EVIDENCE_A,
      }),
    });
    await expectStatus(createMetricDeltaA, 201);

    const createMetricDeltaB = await appB.request('/api/v1/metric-deltas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: METRIC_DELTA_B,
        packet_id: PACKET_B,
        metric_id: 'rls.live.metric',
        before_value: 3,
        after_value: 4,
        evidence_item_id: EVIDENCE_B,
      }),
    });
    await expectStatus(createMetricDeltaB, 201);

    const readA = await appA.request('/api/v1/packets');
    await expectStatus(readA, 200);
    const bodyA = await readA.json() as { packets: Array<{ id: string }> };
    expect(bodyA.packets.map((p) => p.id)).toContain(PACKET_A);
    expect(bodyA.packets.map((p) => p.id)).not.toContain(PACKET_B);

    const readB = await appB.request('/api/v1/packets');
    await expectStatus(readB, 200);
    const bodyB = await readB.json() as { packets: Array<{ id: string }> };
    expect(bodyB.packets.map((p) => p.id)).toContain(PACKET_B);
    expect(bodyB.packets.map((p) => p.id)).not.toContain(PACKET_A);

    const assertScopedList = async (
      app: Hono,
      path: string,
      key: 'evidence' | 'approvals' | 'tool_events' | 'metric_deltas',
      includeId: string,
      excludeId: string,
    ) => {
      const response = await app.request(path);
      await expectStatus(response, 200);
      const body = await response.json() as Record<typeof key, Array<{ id: string }>>;
      const ids = body[key].map((item) => item.id);
      expect(ids).toContain(includeId);
      expect(ids).not.toContain(excludeId);
    };

    await assertScopedList(appA, '/api/v1/evidence', 'evidence', EVIDENCE_A, EVIDENCE_B);
    await assertScopedList(appB, '/api/v1/evidence', 'evidence', EVIDENCE_B, EVIDENCE_A);
    await assertScopedList(appA, '/api/v1/approvals', 'approvals', APPROVAL_A, APPROVAL_B);
    await assertScopedList(appB, '/api/v1/approvals', 'approvals', APPROVAL_B, APPROVAL_A);
    await assertScopedList(appA, '/api/v1/tool-events', 'tool_events', TOOL_EVENT_A, TOOL_EVENT_B);
    await assertScopedList(appB, '/api/v1/tool-events', 'tool_events', TOOL_EVENT_B, TOOL_EVENT_A);
    await assertScopedList(appA, '/api/v1/metric-deltas', 'metric_deltas', METRIC_DELTA_A, METRIC_DELTA_B);
    await assertScopedList(appB, '/api/v1/metric-deltas', 'metric_deltas', METRIC_DELTA_B, METRIC_DELTA_A);
  });
});
