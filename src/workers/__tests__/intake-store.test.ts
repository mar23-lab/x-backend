import { describe, expect, it } from 'vitest';
import {
  countGovernedExecutionReceiptsRow,
  createIntakeResolutionRow,
  executeIntakeResolutionRow,
  listGovernedExecutionReceiptsRow,
} from '../dal/intake-store';
import { neonClient } from '../db/client';

const RESOLUTION = {
  id: 'inr_1', workspace_id: 'ws_1', actor_user_id: 'user_1', project_id: 'proj_1',
  client_request_id: 'resolve_1', interaction_id: 'interaction_1',
  request_digest: 'a'.repeat(64), operation: 'create_work',
  confidence: 0.99, ambiguity: false, target: { type: 'task_packet', id: null, label: 'Launch' },
  effect_summary: 'Create launch packet', risk: 'medium', authority: { allowed: true, safe_reason: 'operator' },
  context_summary: { reference_count: 0, source_count: 0, evidence_count: 0 }, required_tools: [],
  requires_confirmation: true, next_step: 'confirm', action_payload: { title: 'Launch', project_id: 'proj_1' },
  current_work_version: 0, version: 1, status: 'consumed', expires_at: '2099-01-01T00:00:00Z',
  consumed_at: '2026-07-15T00:00:00Z', created_at: '2026-07-15T00:00:00Z',
};

const EXECUTION_ROW = {
  ...RESOLUTION,
  receipt_id: 'ger_1', receipt_client_request_id: 'execute_1',
  receipt_target_type: 'task_packet', receipt_target_id: 'pkt_1', receipt_created_at: '2026-07-15T00:00:01Z',
  receipt_closing_attestation_id: 'cla_1',
  receipt_interaction_id: 'interaction_1',
  receipt_intent_id: 'int_1',
  receipt_operation_event_id: 'evt_1',
  receipt_audit_event_id: '91',
  receipt_projection_outbox_id: 'out_1',
  receipt_conversation_message_id: '501',
};

const CLOSING = {
  role_key: 'role.workspace.owner', closing_skill: 'skill.governed-execution-closeout', outcome: 'attested' as const,
  evidence_ref_ids: ['intake-resolution:inr_1'], content_sha256: 'b'.repeat(64), signature_alg: 'none' as const, signature: null,
};

function sqlWith(transactionRows: unknown[][]) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let transactionIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = { text: strings.join('?'), values };
    statements.push(statement);
    return statement as never;
  };
  (tag as unknown as { transaction: unknown }).transaction = async (build: (tx: unknown) => unknown[]) => {
    const queries = build(tag);
    const rows = transactionRows[transactionIndex++] ?? [];
    return queries.map((_, index) => index === 0 ? [] : rows);
  };
  return { sql: tag as never, statements };
}

describe('single-intake transactional execution', () => {
  it('returns a stable conflict code when a client request id is reused for different input', async () => {
    const { sql } = sqlWith([[]]);
    await expect(createIntakeResolutionRow(sql, 'ws_1', 'user_1', {
      client_request_id: 'resolve_reused',
      request_digest: 'a'.repeat(64),
      operation: 'answer',
      confidence: 0.99,
      ambiguity: false,
      target: { type: 'read_model', id: 'ws_1', label: 'Workspace' },
      effect_summary: 'Answer without changing governed work.',
      risk: 'low',
      authority: { allowed: true, safe_reason: 'read_only_or_draft' },
      context_summary: { reference_count: 0, source_count: 0, evidence_count: 0 },
      requires_confirmation: false,
      next_step: 'answer_now',
      expires_at: '2099-01-01T00:00:00Z',
    })).rejects.toMatchObject({
      code: 'INTAKE_REQUEST_ID_CONFLICT',
      status: 409,
    });
  });

  it('counts receipts through the tenant RLS context without returning receipt data', async () => {
    const { sql, statements } = sqlWith([[{ receipt_count: '3' }]]);
    const count = await countGovernedExecutionReceiptsRow(sql, 'ws_1');
    expect(count).toBe(3);
    const query = statements.find((statement) => statement.text.includes('governed_execution_receipts'))!;
    expect(query.text).toContain('WHERE workspace_id =');
    expect(query.values).toContain('ws_1');
  });

  it('lists bounded receipts through the tenant RLS context for reload projections', async () => {
    const receipt = {
      id: 'ger_1',
      workspace_id: 'ws_1',
      resolution_id: 'inr_1',
      actor_user_id: 'user_1',
      client_request_id: 'exec_1',
      operation: 'create_work',
      target_type: 'task_packet',
      target_id: 'pkt_1',
      result: 'completed',
      effect_summary: 'Created work',
      closing_attestation_id: null,
      created_at: '2026-07-15T00:00:01Z',
    };
    const { sql, statements } = sqlWith([[receipt]]);
    const rows = await listGovernedExecutionReceiptsRow(sql, 'ws_1', 500);
    expect(rows).toEqual([{
      ...receipt,
      intent_id: null,
      operation_event_id: null,
      audit_event_id: null,
      projection_outbox_id: null,
      conversation_message_id: null,
    }]);
    const query = statements.find((statement) => statement.text.includes('ORDER BY created_at DESC'))!;
    expect(query.text).toContain('WHERE workspace_id =');
    expect(query.values).toContain('ws_1');
    expect(query.values).toContain(200);
  });

  it('binds project validation and the execution idempotency key into the atomic write', async () => {
    const { sql, statements } = sqlWith([[EXECUTION_ROW]]);
    const result = await executeIntakeResolutionRow(
      sql, 'ws_1', 'user_1', 'inr_1', 1, 0, 'execute_1', 'interaction_1', 'thr_project_thread_1', CLOSING,
    );
    expect(result).toMatchObject({
      ok: true,
      packet_id: 'pkt_1',
      read_model_watermark: '2026-07-15T00:00:01Z',
      receipt: {
        client_request_id: 'execute_1',
        interaction_id: 'interaction_1',
        closing_attestation_id: 'cla_1',
        intent_id: 'int_1',
        operation_event_id: 'evt_1',
        audit_event_id: '91',
        projection_outbox_id: 'out_1',
        conversation_message_id: '501',
      },
    });
    const write = statements.find((statement) => statement.text.includes('WITH claimed AS'))!;
    expect(write.text).toContain("p.workspace_id = intake_resolutions.workspace_id");
    expect(write.text).toContain("p.status <> 'archived'");
    expect(write.text).toContain('client_request_id');
    expect(write.values).toContain('execute_1');
    expect(write.values).toContain('interaction_1');
    expect(write.values).toContain('thr_project_thread_1');
    expect(write.text).toContain('requested_thread.status =');
    expect(write.text).toContain('requested_conversation_thread');
    expect(write.text).toContain('INSERT INTO intents');
    expect(write.text).toContain('INSERT INTO operation_events');
    expect(write.text).toContain('INSERT INTO audit_logs');
    expect(write.text).toContain('INSERT INTO closing_attestations');
    expect(write.values).toContain('skill.governed-execution-closeout');
    expect(write.text).toContain('INSERT INTO projection_outbox');
    expect(write.text).toContain('INSERT INTO chat_messages');
    expect(write.text).toContain('JOIN intent_written i ON i.id = r.intent_id');
    expect(write.text).toContain('JOIN operation_event_written o ON o.id = r.operation_event_id');
    expect(write.text).toContain('JOIN audit_written a ON a.id::text = r.audit_event_id');
    expect(write.text).toContain('JOIN queued q ON q.id = r.projection_outbox_id');
    expect(write.text).toContain('JOIN conversation_message m ON m.id = r.conversation_message_id');
  });

  it('replays the original receipt for the same execution idempotency key', async () => {
    const { sql } = sqlWith([[], [EXECUTION_ROW]]);
    const result = await executeIntakeResolutionRow(
      sql, 'ws_1', 'user_1', 'inr_1', 1, 0, 'execute_1', 'interaction_1', null, CLOSING,
    );
    expect(result).toMatchObject({ ok: true, replayed: true, packet_id: 'pkt_1', receipt: { id: 'ger_1' } });
  });

  it('does not replay a consumed resolution for a different execution key', async () => {
    const { sql } = sqlWith([[], [EXECUTION_ROW]]);
    const result = await executeIntakeResolutionRow(
      sql, 'ws_1', 'user_1', 'inr_1', 1, 0, 'execute_other', 'interaction_1', null, CLOSING,
    );
    expect(result).toEqual({ ok: false, reason: 'already_consumed' });
  });

  it('cannot claim or replay a resolution through a different interaction', async () => {
    const { sql, statements } = sqlWith([[], [], [{ status: 'consumed', expires_at: RESOLUTION.expires_at, version: 1, current_work_version: 0 }]]);
    const result = await executeIntakeResolutionRow(
      sql, 'ws_1', 'user_1', 'inr_1', 1, 0, 'execute_1', 'interaction_other', null, CLOSING,
    );
    expect(result).toEqual({ ok: false, reason: 'already_consumed' });
    const write = statements.find((statement) => statement.text.includes('WITH claimed AS'))!;
    expect(write.text).toContain('AND interaction_id =');
    expect(write.values).toContain('interaction_other');
    const replay = statements.find((statement) => statement.text.includes('JOIN governed_execution_receipts'))!;
    expect(replay.text).toContain('AND c.interaction_id =');
  });
});

const runLiveRlsProbe = process.env.XLOOOP_RUN_INTAKE_RLS_LIVE === '1';
const describeLiveRls = runLiveRlsProbe ? describe : describe.skip;

describeLiveRls('single-intake live RLS insert', () => {
  it('creates and returns an answer resolution through the app-role connection', async () => {
    const appDatabaseUrl = process.env.XLOOOP_RLS_APP_DATABASE_URL;
    const ownerDatabaseUrl = process.env.DATABASE_URL;
    const workspaceId = process.env.XLOOOP_LIVE_WORKSPACE_ID;
    const actorUserId = process.env.XLOOOP_LIVE_ACTOR_USER_ID;
    if (!appDatabaseUrl || !ownerDatabaseUrl || !workspaceId || !actorUserId) {
      throw new Error('live intake RLS probe requires app/owner DSNs plus workspace and actor ids');
    }

    const appSql = neonClient(appDatabaseUrl);
    const ownerSql = neonClient(ownerDatabaseUrl);
    const clientRequestId = `intake-rls-probe-${crypto.randomUUID()}`;
    try {
      const resolution = await createIntakeResolutionRow(appSql, workspaceId, actorUserId, {
        project_id: null,
        client_request_id: clientRequestId,
        request_digest: 'a'.repeat(64),
        operation: 'answer',
        confidence: 0.99,
        ambiguity: false,
        target: { type: 'read_model', id: workspaceId, label: 'Workspace' },
        effect_summary: 'Answer without changing governed work.',
        risk: 'low',
        authority: { allowed: true, safe_reason: 'read_only_or_draft' },
        context_summary: { reference_count: 0, source_count: 0, evidence_count: 0 },
        requires_confirmation: false,
        next_step: 'answer_now',
        action_payload: {},
        current_work_version: 0,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      expect(resolution).toMatchObject({
        workspace_id: workspaceId,
        actor_user_id: actorUserId,
        client_request_id: clientRequestId,
        operation: 'answer',
        next_step: 'answer_now',
      });
    } finally {
      await ownerSql`
        DELETE FROM intake_resolutions
         WHERE workspace_id = ${workspaceId}
           AND actor_user_id = ${actorUserId}
           AND client_request_id = ${clientRequestId}
      `;
    }
  });
});
