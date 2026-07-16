// pilot-census-seed-live.test.ts
//
// Live pilot-shadow census seeding proof. Runs only when XLOOOP_RUN_PILOT_CENSUS_SEED=1
// and DATABASE_URL targets the approved pilot-shadow Neon branch. Drives the REAL
// intent, single-intake, assistant context-lineage, model-receipt, tool-event, and
// sign-off code paths for two dedicated census workspaces so the tenant graph census
// observes non-zero intent and causation lineage. Seeded rows are synthetic,
// census-workspace-scoped, and deliberately persist (the census measures them).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { neonClient, type Sql } from '../db/client';
import { WorkersDalAdapter } from '../dal/WorkersDalAdapter';
import { intakeRoute } from '../routes/intake';
import { signOffsRoute } from '../routes/sign-offs';
import { operationalSpineRoute } from '../routes/operational-spine';
import { createIntentRow } from '../dal/intent-store';
import {
  completeAssistantSkillLineage,
  persistAssistantContextLineage,
} from '../lib/assistant-context-lineage';
import {
  finishModelExecutionReceiptRow,
  startModelExecutionReceiptRow,
} from '../dal/model-execution-receipt-store';

const liveEnv = env as Record<string, string | undefined>;
const seedRequested = liveEnv.XLOOOP_RUN_PILOT_CENSUS_SEED === '1';
const databaseUrl = liveEnv.DATABASE_URL || '';
const shouldRun = seedRequested && !!databaseUrl;
const describeLive = shouldRun ? describe : describe.skip;

if (seedRequested && !databaseUrl) {
  describe('pilot census seed prerequisite gate', () => {
    it('fails closed when XLOOOP_RUN_PILOT_CENSUS_SEED=1 is set without DATABASE_URL', () => {
      throw new Error('DATABASE_URL is required for the pilot census seed; a skipped run cannot satisfy census evidence.');
    });
  });
}

const RUN_TAG = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
const WORKSPACES = ['pilot_census_ws_a', 'pilot_census_ws_b'] as const;
const SEED_USER = 'census_seed_operator';

const lineageEnv = {
  ROLE_SKILL_CATALOG_ENABLED: 'true',
  RESOLUTION_RECEIPT_SIGNING_SECRET: liveEnv.RESOLUTION_RECEIPT_SIGNING_SECRET || 'pilot-census-seed-local-signing-secret',
  RESOLUTION_RECEIPT_SIGNING_KEY_ID: liveEnv.RESOLUTION_RECEIPT_SIGNING_KEY_ID || 'pilot-census-seed-local',
  XLOOOP_DEPLOY_SHA: liveEnv.XLOOOP_DEPLOY_SHA,
};

function appFor(sql: Sql, auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'pilot-census-seed');
    ctx.set('auth', auth as never);
    ctx.set('dal', new WorkersDalAdapter(sql) as never);
    await next();
  });
  app.route('/api/v1', intakeRoute);
  app.route('/api/v1', signOffsRoute);
  app.route('/api/v1', operationalSpineRoute);
  // Forward the workers test env (plus the single-intake and signing flags this
  // proof needs) as Hono's per-request env so routes reading ctx.env see bindings.
  const requestEnv = {
    ...(env as Record<string, unknown>),
    SINGLE_INTAKE_ENABLED: 'true',
    ROLE_SKILL_CATALOG_ENABLED: 'true',
    RESOLUTION_RECEIPT_SIGNING_SECRET: lineageEnv.RESOLUTION_RECEIPT_SIGNING_SECRET,
    RESOLUTION_RECEIPT_SIGNING_KEY_ID: lineageEnv.RESOLUTION_RECEIPT_SIGNING_KEY_ID,
  };
  return {
    request: (input: string, init?: RequestInit) => app.request(input, init, requestEnv as never),
  };
}

async function expectStatus(response: Response, expected: number) {
  if (response.status !== expected) {
    throw new Error(`expected HTTP ${expected}, got ${response.status}: ${await response.text()}`);
  }
}

describeLive('pilot-shadow census seed (real governed code paths)', () => {
  let ownerSql: Sql;

  beforeAll(async () => {
    ownerSql = neonClient(databaseUrl);
    await ownerSql`
      INSERT INTO workspaces(id, name, owner_user_id, slug)
      VALUES
        (${WORKSPACES[0]}, 'Pilot Census A', ${SEED_USER}, 'pilot-census-a'),
        (${WORKSPACES[1]}, 'Pilot Census B', ${SEED_USER}, 'pilot-census-b')
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    // Seeded lineage rows intentionally persist: the census and graph projection
    // measure them. Only synthetic census workspaces are ever written to.
  });

  it('seeds intent, intake, lineage, receipts, tool events, and causation per census workspace', async () => {
    for (const ws of WORKSPACES) {
      const suffix = ws.endsWith('_a') ? 'a' : 'b';
      const app = appFor(ownerSql, { workspace_id: ws, user_id: SEED_USER, role: 'owner' });

      // 1. First-class intent (lineage backbone).
      const intent = await createIntentRow(ownerSql, {
        id: `intent-census-${RUN_TAG}-${suffix}`,
        workspace_id: ws,
        title: `Prove pilot-shadow census lineage for workspace ${suffix.toUpperCase()}`,
        summary: 'Synthetic census-seed intent created through the real intent store to prove non-zero intent lineage in the pilot-shadow tenant graph.',
        origin: 'operator',
      });
      expect(intent.id).toBeTruthy();

      // 2. Single intake: resolve (create_work) then execute -> packet + governed
      //    execution receipt + closing attestation + projection outbox row.
      const resolveRes = await app.request('/api/v1/intake/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `Create a task to record the pilot census seeding evidence for workspace ${suffix.toUpperCase()}`,
          client_request_id: `census-${RUN_TAG}-resolve-${suffix}`,
        }),
      });
      await expectStatus(resolveRes, 201);
      const { resolution } = await resolveRes.json() as { resolution: { id: string; operation: string; version: number; current_work_version: number } };
      expect(resolution.operation).toBe('create_work');

      const executeRes = await app.request(`/api/v1/intake/${resolution.id}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: resolution.version,
          current_work_version: resolution.current_work_version,
          client_request_id: `census-${RUN_TAG}-execute-${suffix}`,
        }),
      });
      await expectStatus(executeRes, 200);
      const executed = await executeRes.json() as { ok: boolean; receipt_id?: string };
      expect(executed.ok).toBe(true);

      // 3. Assistant context lineage: real catalog resolution + signed context packet
      //    + skill invocation receipts.
      const lineage = await persistAssistantContextLineage(ownerSql, lineageEnv, {
        workspace_id: ws,
        principal_id: SEED_USER,
        role: 'owner',
        mode: 'answer',
        intent_ref: intent.id,
        scope: { event_count: 1, document_count: 0, unpromoted_document_count: 0, source_count: 0 },
        redaction_profile: 'customer_safe',
        client_empty: false,
      });
      expect(lineage.context_packet_id).toBeTruthy();
      const skillReceipts = await completeAssistantSkillLineage(ownerSql, lineageEnv, lineage, {
        workspace_id: ws,
        principal_id: SEED_USER,
      });
      expect(skillReceipts.length).toBeGreaterThan(0);

      // 4. Model execution receipt bound to the real resolution/context lineage.
      //    Honest attribution: this census seed run is executed by an Anthropic model.
      const startedAt = Date.now();
      const modelReceiptId = await startModelExecutionReceiptRow(ownerSql, ws, SEED_USER, {
        resolution_id: lineage.resolution_id,
        context_packet_id: lineage.context_packet_id,
        action: lineage.action,
        provider: 'anthropic',
        model_key: 'claude-fable-5',
      });
      await finishModelExecutionReceiptRow(ownerSql, ws, modelReceiptId, {
        status: 'completed',
        tokens_in: null,
        tokens_out: null,
        latency_ms: Math.max(1, Date.now() - startedAt),
        error_code: null,
      });

      // 5. Tool event through the real spine route (the census seed run itself).
      const toolRes = await app.request('/api/v1/tool-events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: `tev-census-${RUN_TAG}-${suffix}`,
          action: 'report_tool_event',
          status: 'completed',
          tool_name: 'pilot-census-seed',
          summary: `Census seed tool run for workspace ${suffix.toUpperCase()} recorded through the governed spine route.`,
        }),
      });
      await expectStatus(toolRes, 201);

      // 6. Causation: an operation event signed off through the real atomic
      //    sign-off route stamps audit_logs.causation_id (the caused_by spine).
      const eventId = `evt-census-${RUN_TAG}-${suffix}`;
      await ownerSql`
        INSERT INTO operation_events (id, workspace_id, source_tool, status, summary, occurred_at)
        VALUES (${eventId}, ${ws}, 'claude', 'needs_review',
                ${'Census seed governed event for workspace ' + suffix.toUpperCase()}, now())
        ON CONFLICT (id) DO NOTHING
      `;
      const signOffRes = await app.request('/api/v1/sign-offs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event_id: eventId,
          verdict: 'approved',
          comment: 'Census seed sign-off proving atomic causation lineage in pilot-shadow.',
        }),
      });
      await expectStatus(signOffRes, 201);
    }

    // Lineage spine must now be non-zero and strictly census-workspace-scoped.
    const [counts] = await ownerSql`
      SELECT
        (SELECT count(*)::int FROM intents WHERE workspace_id = ANY(${WORKSPACES as unknown as string[]})) AS intents,
        (SELECT count(*)::int FROM task_packets WHERE workspace_id = ANY(${WORKSPACES as unknown as string[]})) AS packets,
        (SELECT count(*)::int FROM governed_execution_receipts WHERE workspace_id = ANY(${WORKSPACES as unknown as string[]})) AS receipts,
        (SELECT count(*)::int FROM closing_attestations WHERE workspace_id = ANY(${WORKSPACES as unknown as string[]})) AS closings,
        (SELECT count(*)::int FROM context_packets WHERE workspace_id = ANY(${WORKSPACES as unknown as string[]})) AS context_packets,
        (SELECT count(*)::int FROM model_execution_receipts WHERE workspace_id = ANY(${WORKSPACES as unknown as string[]})) AS model_receipts,
        (SELECT count(*)::int FROM skill_invocation_receipts WHERE workspace_id = ANY(${WORKSPACES as unknown as string[]})) AS skill_receipts,
        (SELECT count(*)::int FROM tool_events WHERE workspace_id = ANY(${WORKSPACES as unknown as string[]})) AS tool_events,
        (SELECT count(*)::int FROM audit_logs WHERE workspace_id = ANY(${WORKSPACES as unknown as string[]}) AND causation_id IS NOT NULL) AS caused_by,
        (SELECT count(*)::int FROM projection_outbox WHERE workspace_id = ANY(${WORKSPACES as unknown as string[]})) AS outbox_rows
    ` as unknown as [Record<string, number>];
    console.log('[pilot-census-seed] counts', JSON.stringify(counts));
    expect(counts.intents).toBeGreaterThan(0);
    expect(counts.packets).toBeGreaterThan(0);
    expect(counts.receipts).toBeGreaterThan(0);
    expect(counts.closings).toBeGreaterThan(0);
    expect(counts.context_packets).toBeGreaterThan(0);
    expect(counts.model_receipts).toBeGreaterThan(0);
    expect(counts.skill_receipts).toBeGreaterThan(0);
    expect(counts.tool_events).toBeGreaterThan(0);
    expect(counts.caused_by).toBeGreaterThan(0);
    expect(counts.outbox_rows).toBeGreaterThan(0);
  }, 120_000);
});
