import { Client, type QueryConfig } from 'pg';
import { describe, expect, it } from 'vitest';
import { appendChatExchangeRow } from '../dal/chat-store';
import { saveWorkspaceReadinessAssessmentRow } from '../dal/customer-readiness-store';
import { createIntakeResolutionRow, executeIntakeResolutionRow } from '../dal/intake-store';
import { recordCustomerConsentAckRow, revokeCustomerAuthorityRow } from '../dal/customer-authority-store';
import type { Sql } from '../db/client';

type DeferredQuery = QueryConfig<unknown[]>;

function postgresSql(client: Client): Sql {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]): DeferredQuery => {
    let text = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    const query = { text, values } as DeferredQuery & PromiseLike<unknown[]>;
    Object.defineProperty(query, 'then', {
      enumerable: false,
      value: (
        resolve: (rows: unknown[]) => unknown,
        reject: (error: unknown) => unknown,
      ) => client.query(query).then((result) => resolve(result.rows), reject),
    });
    return query;
  }) as unknown as Sql;

  (tag as unknown as {
    transaction: (
      build: (tx: Sql) => DeferredQuery[],
      opts?: { readOnly?: boolean },
    ) => Promise<unknown[][]>;
  }).transaction = async (build, opts = {}) => {
    await client.query('BEGIN');
    try {
      if (opts.readOnly) await client.query('SET TRANSACTION READ ONLY');
      const results: unknown[][] = [];
      for (const query of build(tag)) {
        try {
          const result = await client.query(query);
          results.push(result.rows);
        } catch (error) {
          const parameterTypes = (query.values ?? [])
            .map((value, index) => `$${index + 1}:${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`)
            .join(', ');
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; parameter types: ${parameterTypes}`,
            { cause: error },
          );
        }
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };
  return tag;
}

const databaseUrl = process.env.XLOOOP_SCHEMA91_PG_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('schema 91 PostgreSQL authority', () => {
  it('persists and replays one authenticated onboarding baseline with durable readback', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    const suffix = crypto.randomUUID().replaceAll('-', '');
    const workspaceId = `ws_readiness_pg91_${suffix}`;
    const userId = `user_readiness_pg91_${suffix}`;
    const email = `${suffix}@example.test`;
    const clientRequestId = `readiness_pg91_${suffix}`;
    const requestDigest = 'd'.repeat(64);

    try {
      await client.query(
        `INSERT INTO users (id, email, status, approved_at)
         VALUES ($1, $2, 'approved', now())`,
        [userId, email],
      );
      await client.query(
        `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, relationship_status)
         VALUES ($1, 'Readiness schema 91 integration', $2, 'company', 'internal_dogfood')`,
        [workspaceId, userId],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at)
         VALUES ($1, $2, 'owner', 'active', now())`,
        [workspaceId, userId],
      );

      const sql = postgresSql(client);
      const input = {
        workspace_id: workspaceId,
        user_id: userId,
        client_request_id: clientRequestId,
        request_digest: requestDigest,
        email,
        account_type: 'company' as const,
        company_name: 'Readiness integration',
        readiness_answers: {
          focus_90d: 'Prove onboarding durability',
          business_direction: 'Grow',
        },
        consent: { profile_saved: true },
        source: 'inapp-readiness-profile',
      };
      const saved = await saveWorkspaceReadinessAssessmentRow(sql, input);

      expect(saved).toMatchObject({
        workspace_id: workspaceId,
        user_id: userId,
        email,
        replayed: false,
        request_digest: requestDigest,
      });
      expect(saved.readiness_revision_id).toBe(
        `readiness:${saved.id}:${saved.audit_event_id}`,
      );

      const readback = await client.query(
        `SELECT
           r.id,
           r.workspace_id,
           r.user_id,
           r.readiness_answers,
           a.id::text AS audit_event_id,
           a.metadata->>'client_request_id' AS client_request_id,
           a.metadata->>'request_digest' AS request_digest
         FROM readiness_assessments r
         JOIN audit_logs a
           ON a.workspace_id = r.workspace_id
          AND a.action = 'readiness_update'
          AND a.metadata->>'readiness_assessment_id' = r.id
        WHERE r.id = $1 AND r.workspace_id = $2`,
        [saved.id, workspaceId],
      );
      expect(readback.rows).toEqual([expect.objectContaining({
        id: saved.id,
        workspace_id: workspaceId,
        user_id: userId,
        audit_event_id: saved.audit_event_id,
        client_request_id: clientRequestId,
        request_digest: requestDigest,
        readiness_answers: expect.objectContaining({
          focus_90d: 'Prove onboarding durability',
        }),
      })]);

      const replay = await saveWorkspaceReadinessAssessmentRow(sql, input);
      expect(replay).toMatchObject({
        id: saved.id,
        audit_event_id: saved.audit_event_id,
        readiness_revision_id: saved.readiness_revision_id,
        replayed: true,
      });

      await expect(saveWorkspaceReadinessAssessmentRow(sql, {
        ...input,
        request_digest: 'e'.repeat(64),
      })).rejects.toMatchObject({
        code: 'CONFLICT',
        status: 409,
      });

      const authorityCounts = await client.query(
        `SELECT
           (SELECT count(*)::integer
              FROM readiness_assessments
             WHERE workspace_id = $1) AS readiness_count,
           (SELECT count(*)::integer
              FROM audit_logs
             WHERE workspace_id = $1
               AND action = 'readiness_update'
               AND metadata->>'client_request_id' = $2) AS audit_count`,
        [workspaceId, clientRequestId],
      );
      expect(authorityCounts.rows[0]).toEqual({
        readiness_count: 1,
        audit_count: 1,
      });
    } finally {
      await client.query('DELETE FROM audit_logs WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM readiness_assessments WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM access_requests WHERE invited_to_workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.end();
    }
  });

  it('writes and replays one complete project-scoped execution lineage', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    const suffix = crypto.randomUUID().replaceAll('-', '');
    const workspaceId = `ws_pg91_${suffix}`;
    const userId = `user_pg91_${suffix}`;
    const projectId = `proj_pg91_${suffix}`;
    const interactionId = `interaction_pg91_${suffix}`;
    const resolveRequestId = `resolve_pg91_${suffix}`;
    const executeRequestId = `execute_pg91_${suffix}`;

    try {
      await client.query(
        `INSERT INTO users (id, email, status, approved_at)
         VALUES ($1, $2, 'approved', now())`,
        [userId, `${suffix}@example.test`],
      );
      await client.query(
        `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, relationship_status)
         VALUES ($1, 'Schema 91 integration', $2, 'company', 'internal_dogfood')`,
        [workspaceId, userId],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at)
         VALUES ($1, $2, 'owner', 'active', now())`,
        [workspaceId, userId],
      );
      await client.query(
        `INSERT INTO projects (id, workspace_id, name, status)
         VALUES ($1, $2, 'Project-scoped execution', 'active')`,
        [projectId, workspaceId],
      );

      const sql = postgresSql(client);
      const resolution = await createIntakeResolutionRow(sql, workspaceId, userId, {
        project_id: projectId,
        client_request_id: resolveRequestId,
        interaction_id: interactionId,
        request_digest: 'a'.repeat(64),
        operation: 'create_work',
        confidence: 0.99,
        ambiguity: false,
        target: { type: 'task_packet', id: null, label: 'Production-user recovery' },
        effect_summary: 'Create one durable project-scoped recovery packet.',
        risk: 'medium',
        authority: { allowed: true, safe_reason: 'explicit owner confirmation required' },
        context_summary: { reference_count: 1, source_count: 1, evidence_count: 0 },
        prior_work: {
          discovery_executed: true,
          active_work_count: 0,
          pending_approval_count: 0,
          digest_sha256: 'b'.repeat(64),
        },
        governance_summary: 'Project-scoped, exactly-once governed execution.',
        role_label: 'Workspace owner',
        approach_label: 'Create governed work',
        grounding_summary: 'Grounded on the selected project.',
        guardrails: ['No production cutover'],
        freshness: {
          generated_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
        required_tools: [],
        requires_confirmation: true,
        next_step: 'confirm',
        action_payload: {
          project_id: projectId,
          title: 'Production-user recovery',
          summary: 'Repair durable customer execution and reload continuity.',
        },
        current_work_version: 0,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });

      const closing = {
        role_key: 'role.workspace.owner',
        closing_skill: 'skill.governed-execution-closeout',
        outcome: 'attested' as const,
        evidence_ref_ids: [`intake-resolution:${resolution.id}`],
        content_sha256: 'c'.repeat(64),
        signature_alg: 'none' as const,
        signature: null,
      };
      const executed = await executeIntakeResolutionRow(
        sql,
        workspaceId,
        userId,
        resolution.id,
        resolution.version,
        resolution.current_work_version,
        executeRequestId,
        interactionId,
        closing,
      );
      expect(executed).toMatchObject({
        ok: true,
        receipt: {
          interaction_id: interactionId,
          operation: 'create_work',
          target_type: 'task_packet',
        },
      });
      if (!executed.ok) throw new Error(`unexpected execution result: ${executed.reason}`);

      const references = await client.query(
        `SELECT
           EXISTS (SELECT 1 FROM task_packets WHERE id = $1 AND workspace_id = $2) AS packet,
           EXISTS (SELECT 1 FROM intents WHERE id = $3 AND workspace_id = $2) AS intent,
           EXISTS (SELECT 1 FROM operation_events WHERE id = $4 AND workspace_id = $2) AS event,
           EXISTS (SELECT 1 FROM audit_logs WHERE id::text = $5 AND workspace_id = $2) AS audit,
           EXISTS (SELECT 1 FROM closing_attestations WHERE id = $6 AND workspace_id = $2) AS closing,
           EXISTS (SELECT 1 FROM projection_outbox WHERE id = $7 AND workspace_id = $2) AS outbox,
           EXISTS (
             SELECT 1 FROM chat_messages m
             JOIN chat_threads t ON t.id = m.thread_id
             WHERE m.id::text = $8 AND t.workspace_id = $2
               AND m.interaction_id = $9 AND m.entry_type = 'execution_outcome'
           ) AS conversation`,
        [
          executed.receipt.target_id,
          workspaceId,
          executed.receipt.intent_id,
          executed.receipt.operation_event_id,
          executed.receipt.audit_event_id,
          executed.receipt.closing_attestation_id,
          executed.receipt.projection_outbox_id,
          executed.receipt.conversation_message_id,
          interactionId,
        ],
      );
      expect(references.rows[0]).toEqual({
        packet: true,
        intent: true,
        event: true,
        audit: true,
        closing: true,
        outbox: true,
        conversation: true,
      });

      const replay = await executeIntakeResolutionRow(
        sql,
        workspaceId,
        userId,
        resolution.id,
        resolution.version,
        resolution.current_work_version,
        executeRequestId,
        interactionId,
        closing,
      );
      expect(replay).toMatchObject({
        ok: true,
        replayed: true,
        receipt: { id: executed.receipt.id },
      });
      const receiptCount = await client.query(
        `SELECT count(*)::integer AS count
           FROM governed_execution_receipts
          WHERE workspace_id = $1 AND interaction_id = $2`,
        [workspaceId, interactionId],
      );
      expect(receiptCount.rows[0]?.count).toBe(1);

      const conflictInteractionId = `interaction_conflict_${suffix}`;
      await appendChatExchangeRow(
        sql,
        userId,
        { workspace_id: workspaceId, project_id: projectId },
        [{
          role: 'you',
          body: 'Original immutable request',
          interaction_id: conflictInteractionId,
          entry_type: 'user_request',
        }],
      );
      await expect(appendChatExchangeRow(
        sql,
        userId,
        { workspace_id: workspaceId, project_id: projectId },
        [{
          role: 'you',
          body: 'Different request reusing the same interaction identity',
          interaction_id: conflictInteractionId,
          entry_type: 'user_request',
        }],
      )).rejects.toMatchObject({ code: 'INTERACTION_ID_CONFLICT', status: 409 });
      const immutableMessage = await client.query(
        `SELECT body, count(*) OVER ()::integer AS count
           FROM chat_messages m
           JOIN chat_threads t ON t.id = m.thread_id
          WHERE t.workspace_id = $1 AND m.interaction_id = $2 AND m.entry_type = 'user_request'`,
        [workspaceId, conflictInteractionId],
      );
      expect(immutableMessage.rows).toEqual([{
        body: 'Original immutable request',
        count: 1,
      }]);
    } finally {
      await client.query('DELETE FROM chat_threads WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM operation_events WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM audit_logs WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await client.query('DELETE FROM closing_attestations WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM intents WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.end();
    }
  });

  it('atomically records and revokes customer authority with complete lineage', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();

    const suffix = crypto.randomUUID().replaceAll('-', '');
    const workspaceId = `ws_authority_pg91_${suffix}`;
    const userId = `user_authority_pg91_${suffix}`;
    const consentEventId = `event_authority_consent_${suffix}`;
    const consentOutboxId = `outbox_authority_consent_${suffix}`;
    const revokeEventId = `event_authority_revoke_${suffix}`;
    const revokeOutboxId = `outbox_authority_revoke_${suffix}`;

    try {
      await client.query(
        `INSERT INTO users (id, email, status, approved_at)
         VALUES ($1, $2, 'approved', now())`,
        [userId, `${suffix}@example.test`],
      );
      await client.query(
        `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, relationship_status)
         VALUES ($1, 'Authority schema 91 integration', $2, 'company', 'internal_dogfood')`,
        [workspaceId, userId],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, activated_at)
         VALUES ($1, $2, 'owner', 'active', now())`,
        [workspaceId, userId],
      );

      const sql = postgresSql(client);
      const consentKey = `authority-consent-${suffix}`;
      const consentDigest = 'a'.repeat(64);
      const consent = await recordCustomerConsentAckRow(sql, {
        workspace_id: workspaceId,
        user_id: userId,
        full_name_typed: 'Schema Test Owner',
        scopes_confirmed: { private_sources: true },
        auto_approve_operator_user_id: userId,
        operation_event_id: consentEventId,
        projection_outbox_id: consentOutboxId,
        idempotency_key: consentKey,
        request_sha256: consentDigest,
        idempotency_route: 'POST /api/v1/customer/authority-consent',
        request_id: `request_authority_consent_${suffix}`,
      });
      expect(consent).toMatchObject({
        operation_event_id: consentEventId,
        projection_outbox_id: consentOutboxId,
        consent: {
          workspace_id: workspaceId,
          operator_approved_by: userId,
          consent_acked_by: userId,
        },
      });

      const consentReferences = await client.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM customer_authority_consents
              WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
           ) AS consent,
           EXISTS (
             SELECT 1 FROM operation_events
              WHERE id = $3 AND workspace_id = $2
           ) AS event,
           EXISTS (
             SELECT 1 FROM audit_logs
              WHERE id::text = $4 AND workspace_id = $2
                AND action = 'customer_authority_consent_ack'
           ) AS audit,
           EXISTS (
             SELECT 1 FROM projection_outbox
              WHERE id = $5 AND workspace_id = $2
           ) AS outbox`,
        [
          consent.consent.id,
          workspaceId,
          consent.operation_event_id,
          consent.audit_event_id,
          consent.projection_outbox_id,
        ],
      );
      expect(consentReferences.rows[0]).toEqual({
        consent: true,
        event: true,
        audit: true,
        outbox: true,
      });

      const consentReplay = await recordCustomerConsentAckRow(sql, {
        workspace_id: workspaceId,
        user_id: userId,
        full_name_typed: 'Schema Test Owner',
        scopes_confirmed: { private_sources: true },
        auto_approve_operator_user_id: userId,
        operation_event_id: `event_authority_consent_replay_${suffix}`,
        projection_outbox_id: `outbox_authority_consent_replay_${suffix}`,
        idempotency_key: consentKey,
        request_sha256: consentDigest,
        idempotency_route: 'POST /api/v1/customer/authority-consent',
        request_id: `request_authority_consent_replay_${suffix}`,
      });
      expect(consentReplay).toMatchObject({
        replayed: true,
        operation_event_id: consent.operation_event_id,
        audit_event_id: consent.audit_event_id,
        projection_outbox_id: consent.projection_outbox_id,
      });
      await expect(recordCustomerConsentAckRow(sql, {
        workspace_id: workspaceId,
        user_id: userId,
        full_name_typed: 'Changed Owner',
        operation_event_id: `event_authority_consent_mismatch_${suffix}`,
        projection_outbox_id: `outbox_authority_consent_mismatch_${suffix}`,
        idempotency_key: consentKey,
        request_sha256: 'c'.repeat(64),
        idempotency_route: 'POST /api/v1/customer/authority-consent',
      })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });

      const revokeKey = `authority-revoke-${suffix}`;
      const revokeDigest = 'b'.repeat(64);
      const revoked = await revokeCustomerAuthorityRow(sql, {
        workspace_id: workspaceId,
        revoked_by: userId,
        revoked_reason: 'schema integration proof',
        re_attest_name: 'Schema Test Owner',
        operation_event_id: revokeEventId,
        projection_outbox_id: revokeOutboxId,
        idempotency_key: revokeKey,
        request_sha256: revokeDigest,
        idempotency_route: 'POST /api/v1/customer/authority-consent/revoke',
        request_id: `request_authority_revoke_${suffix}`,
      });
      expect(revoked).toMatchObject({
        operation_event_id: revokeEventId,
        projection_outbox_id: revokeOutboxId,
        consent: {
          id: consent.consent.id,
          workspace_id: workspaceId,
          revoked_by: userId,
        },
      });

      const revokeReferences = await client.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM customer_authority_consents
              WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NOT NULL
           ) AS revoked,
           EXISTS (
             SELECT 1 FROM operation_events
              WHERE id = $3 AND workspace_id = $2
           ) AS event,
           EXISTS (
             SELECT 1 FROM audit_logs
              WHERE id::text = $4 AND workspace_id = $2
                AND action = 'customer_authority_revoke'
           ) AS audit,
           EXISTS (
             SELECT 1 FROM projection_outbox
              WHERE id = $5 AND workspace_id = $2
           ) AS outbox`,
        [
          revoked.consent.id,
          workspaceId,
          revoked.operation_event_id,
          revoked.audit_event_id,
          revoked.projection_outbox_id,
        ],
      );
      expect(revokeReferences.rows[0]).toEqual({
        revoked: true,
        event: true,
        audit: true,
        outbox: true,
      });

      const revokeReplay = await revokeCustomerAuthorityRow(sql, {
        workspace_id: workspaceId,
        revoked_by: userId,
        operation_event_id: `event_authority_revoke_replay_${suffix}`,
        projection_outbox_id: `outbox_authority_revoke_replay_${suffix}`,
        idempotency_key: revokeKey,
        request_sha256: revokeDigest,
        idempotency_route: 'POST /api/v1/customer/authority-consent/revoke',
      });
      expect(revokeReplay).toMatchObject({
        replayed: true,
        operation_event_id: revoked.operation_event_id,
        audit_event_id: revoked.audit_event_id,
        projection_outbox_id: revoked.projection_outbox_id,
      });
    } finally {
      await client.query('DELETE FROM idempotency_keys WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM projection_outbox WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM audit_logs WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM operation_events WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM customer_authority_consents WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM workspace_members WHERE workspace_id = $1', [workspaceId]);
      await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.end();
    }
  });
});
