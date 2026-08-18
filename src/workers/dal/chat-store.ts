// chat-store.ts · cockpit chat thread persistence (Wave 3) · cross-browser continuity.
//
// Authority: 020_cockpit_chat_threads + 102_project_chat_threads. The deterministic thread remains the
// compatibility/default thread for a user+scope. Commercial clients may create additional explicit
// project threads and must pass their opaque id on history and turn requests.

import { makeError } from './shared-helpers';
import type { Sql } from '../db/client';

export interface ChatScopeRef {
  workspace_id?: string | null;
  project_id?: string | null;
  domain_id?: string | null;
}

export interface ChatMessageInput {
  role: 'you' | 'assistant';
  body: string;
  mode?: string | null;
  generated_by?: string | null;
  grounded_on?: unknown;
  interaction_id?: string | null;
  entry_type?: 'user_request' | 'assistant_answer' | 'resolution_preview' | 'execution_outcome' | 'system_failure' | null;
  resolution_id?: string | null;
  execution_receipt_id?: string | null;
  packet_id?: string | null;
  operation_event_id?: string | null;
  intent_id?: string | null;
  audit_event_id?: string | null;
  closing_attestation_id?: string | null;
  /** W1 (260708) · live links to the operation_events that grounded this answer (migration 058). The route
   *  supplies these only when CHAT_RECEIPT_GROUNDING_ENABLED — absent = legacy insert, byte-identical. */
  grounding_event_ids?: string[] | null;
}

export interface ChatMessageRow {
  id: string;
  thread_id: string;
  role: 'you' | 'assistant';
  body: string;
  mode: string | null;
  generated_by: string | null;
  grounded_on: unknown;
  receipt_uid: string | null;
  interaction_id: string | null;
  entry_type: ChatMessageInput['entry_type'];
  resolution_id: string | null;
  execution_receipt_id: string | null;
  packet_id: string | null;
  operation_event_id: string | null;
  intent_id: string | null;
  audit_event_id: string | null;
  closing_attestation_id: string | null;
  created_at: string;
}

export interface ChatExchangeWriteResult {
  thread_id: string;
  messages: ChatMessageRow[];
}

export type ChatThreadStatus = 'active' | 'archived';
export type ChatThreadTitleSource = 'default' | 'auto' | 'manual' | 'legacy';

export interface ChatThreadRow {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  domain_id: string | null;
  title: string;
  title_source: ChatThreadTitleSource;
  status: ChatThreadStatus;
  message_count: number;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  archived_at: string | null;
}

export interface ChatThreadWriteReceipt {
  thread: ChatThreadRow;
  receipt_id: string;
  audit_event_id: string;
}

const MAX_BODY = 8000;
const norm = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Normalized scope identity — must be stable for the same workspace/project/domain. */
export function chatScopeKey(scope: ChatScopeRef): string {
  return [norm(scope.workspace_id), norm(scope.project_id), norm(scope.domain_id)].join('|');
}

/** Deterministic thread id per (user, scope) so the same operator+scope reuses one thread. */
export function threadIdFor(userId: string, scopeKey: string): string {
  return ('thr_' + norm(userId) + '__' + scopeKey).slice(0, 200);
}

function normalizeChatThreadRow(r: Record<string, unknown>): ChatThreadRow {
  return {
    id: String(r.id ?? ''),
    workspace_id: r.workspace_id == null ? null : String(r.workspace_id),
    project_id: r.project_id == null ? null : String(r.project_id),
    domain_id: r.domain_id == null ? null : String(r.domain_id),
    title: String(r.title || 'New chat'),
    title_source: (['default', 'auto', 'manual', 'legacy'].includes(String(r.title_source))
      ? String(r.title_source) : 'default') as ChatThreadTitleSource,
    status: r.status === 'archived' ? 'archived' : 'active',
    message_count: Number(r.message_count ?? 0),
    created_at: r.created_at ? new Date(r.created_at as string).toISOString() : '',
    updated_at: r.updated_at ? new Date(r.updated_at as string).toISOString() : '',
    last_message_at: r.last_message_at
      ? new Date(r.last_message_at as string).toISOString()
      : (r.updated_at ? new Date(r.updated_at as string).toISOString() : ''),
    archived_at: r.archived_at ? new Date(r.archived_at as string).toISOString() : null,
  };
}

/** Upsert the thread row (idempotent) and return its id. */
export async function getOrCreateChatThreadRow(sql: Sql, userId: string, scope: ChatScopeRef): Promise<string> {
  if (!userId) throw makeError('VALIDATION_ERROR', 'user_id is required', 400);
  const scopeKey = chatScopeKey(scope);
  const id = threadIdFor(userId, scopeKey);
  await sql/*sql*/`
    INSERT INTO chat_threads (id, user_id, workspace_id, project_id, domain_id, scope_key)
    VALUES (${id}, ${userId}, ${scope.workspace_id ?? null}, ${scope.project_id ?? null}, ${scope.domain_id ?? null}, ${scopeKey})
    ON CONFLICT (id) DO UPDATE SET updated_at = now()
  `;
  return id;
}

/** Append an exchange (e.g. the operator's message + the assistant's answer) to the scope's thread. */
export async function appendChatExchangeRow(
  sql: Sql,
  userId: string,
  scope: ChatScopeRef,
  messages: ChatMessageInput[],
  requestedThreadId: string | null = null,
  concurrencyRetry = 0,
): Promise<ChatExchangeWriteResult> {
  const valid = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && (m.role === 'you' || m.role === 'assistant') && typeof m.body === 'string' && m.body.trim(),
  );
  if (!valid.length) return { thread_id: requestedThreadId || threadIdFor(userId, chatScopeKey(scope)), messages: [] };
  if (!userId) throw makeError('VALIDATION_ERROR', 'user_id is required', 400);

  const scopeKey = chatScopeKey(scope);
  const explicitThreadId = String(requestedThreadId || '').trim() || null;
  if (explicitThreadId && (!/^thr_[a-zA-Z0-9_|-]{8,200}$/.test(explicitThreadId))) {
    throw makeError('VALIDATION_ERROR', 'thread_id is invalid', 400);
  }
  const threadId = explicitThreadId || threadIdFor(userId, scopeKey);
  const payload = valid.map((m, sequence) => {
    const links = Array.isArray(m.grounding_event_ids) && m.role === 'assistant'
      ? m.grounding_event_ids.filter((x) => typeof x === 'string' && x).slice(0, 200)
      : null;
    const receiptUid = m.role === 'assistant' ? `rcpt_${crypto.randomUUID().replace(/-/g, '')}` : null;
    return {
      sequence,
      role: m.role,
      body: String(m.body).slice(0, MAX_BODY),
      mode: m.mode ?? null,
      generated_by: m.generated_by ?? null,
      grounded_on: m.grounded_on ?? null,
      grounding_event_ids: links,
      // Commercial chat turns require a durable answer receipt even when the answer did not cite an
      // operation event. Grounding links explain evidence; they are not the identity of the answer.
      receipt_uid: receiptUid,
      interaction_id: m.interaction_id ?? null,
      entry_type: m.entry_type ?? null,
      resolution_id: m.resolution_id ?? null,
      execution_receipt_id: m.execution_receipt_id ?? null,
      packet_id: m.packet_id ?? null,
      operation_event_id: m.operation_event_id ?? null,
      intent_id: m.intent_id ?? null,
      audit_event_id: m.audit_event_id ?? null,
      audit_target_id: m.role === 'assistant' && m.entry_type === 'assistant_answer'
        ? `chat:${scopeKey}:${m.interaction_id ?? receiptUid}`
        : null,
      closing_attestation_id: m.closing_attestation_id ?? null,
    };
  });

  const rows = (await sql/*sql*/`
    WITH input_messages AS MATERIALIZED (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS message(
        sequence integer,
        role text,
        body text,
        mode text,
        generated_by text,
        grounded_on jsonb,
        grounding_event_ids text[],
        receipt_uid text,
        interaction_id text,
        entry_type text,
        resolution_id text,
        execution_receipt_id text,
        packet_id text,
        operation_event_id text,
        intent_id text,
        audit_event_id text,
        audit_target_id text,
        closing_attestation_id text
      )
    ), authorized_thread AS MATERIALIZED (
      SELECT id
      FROM chat_threads
      WHERE id = ${threadId}
        AND user_id = ${userId}
        AND scope_key = ${scopeKey}
        AND workspace_id IS NOT DISTINCT FROM ${scope.workspace_id ?? null}::text
        AND project_id IS NOT DISTINCT FROM ${scope.project_id ?? null}::text
        AND domain_id IS NOT DISTINCT FROM ${scope.domain_id ?? null}::text
        AND COALESCE(status, 'active') = 'active'
    ), existing_messages AS MATERIALIZED (
      SELECT message.sequence, existing.*
      FROM input_messages message
      JOIN chat_messages existing
        ON existing.thread_id = ${threadId}
       AND existing.interaction_id = message.interaction_id
       AND existing.entry_type = message.entry_type
      WHERE message.interaction_id IS NOT NULL AND message.entry_type IS NOT NULL
    ), conflicting_existing AS MATERIALIZED (
      SELECT 1
      FROM input_messages message
      JOIN existing_messages existing ON existing.sequence = message.sequence
      WHERE NOT (
        existing.role = message.role
        AND existing.body = message.body
        AND existing.mode IS NOT DISTINCT FROM message.mode
        AND existing.generated_by IS NOT DISTINCT FROM message.generated_by
        AND existing.grounded_on IS NOT DISTINCT FROM message.grounded_on
        AND existing.grounding_event_ids IS NOT DISTINCT FROM message.grounding_event_ids
        AND existing.resolution_id IS NOT DISTINCT FROM message.resolution_id
        AND existing.execution_receipt_id IS NOT DISTINCT FROM message.execution_receipt_id
        AND existing.packet_id IS NOT DISTINCT FROM message.packet_id
        AND existing.operation_event_id IS NOT DISTINCT FROM message.operation_event_id
        AND existing.intent_id IS NOT DISTINCT FROM message.intent_id
        AND (message.audit_event_id IS NULL OR existing.audit_event_id IS NOT DISTINCT FROM message.audit_event_id)
        AND existing.closing_attestation_id IS NOT DISTINCT FROM message.closing_attestation_id
      )
      LIMIT 1
    ), write_authorized AS MATERIALIZED (
      SELECT true AS allowed
      WHERE NOT EXISTS (SELECT 1 FROM conflicting_existing)
    ), thread_written AS (
      INSERT INTO chat_threads (
        id, user_id, workspace_id, project_id, domain_id, scope_key,
        title, title_source, status, last_message_at
      )
      SELECT
        ${threadId}, ${userId}, ${scope.workspace_id ?? null}, ${scope.project_id ?? null},
        ${scope.domain_id ?? null}, ${scopeKey},
        COALESCE(
          NULLIF(left((SELECT body FROM input_messages WHERE role = 'you' ORDER BY sequence LIMIT 1), 120), ''),
          'New chat'
        ),
        CASE WHEN EXISTS (SELECT 1 FROM input_messages WHERE role = 'you') THEN 'auto' ELSE 'default' END,
        'active', now()
      FROM write_authorized
      WHERE ${explicitThreadId}::text IS NULL OR EXISTS (SELECT 1 FROM authorized_thread)
      ON CONFLICT (id) DO UPDATE SET
        updated_at = now(),
        last_message_at = now(),
        title = CASE
          WHEN chat_threads.title_source = 'default'
          THEN COALESCE(
            NULLIF(left((SELECT body FROM input_messages WHERE role = 'you' ORDER BY sequence LIMIT 1), 120), ''),
            chat_threads.title
          )
          ELSE chat_threads.title
        END,
        title_source = CASE
          WHEN chat_threads.title_source = 'default'
            AND EXISTS (SELECT 1 FROM input_messages WHERE role = 'you')
          THEN 'auto'
          ELSE chat_threads.title_source
        END
      WHERE chat_threads.user_id = ${userId}
        AND chat_threads.scope_key = ${scopeKey}
        AND chat_threads.workspace_id IS NOT DISTINCT FROM ${scope.workspace_id ?? null}::text
        AND chat_threads.project_id IS NOT DISTINCT FROM ${scope.project_id ?? null}::text
        AND chat_threads.domain_id IS NOT DISTINCT FROM ${scope.domain_id ?? null}::text
        AND COALESCE(chat_threads.status, 'active') = 'active'
      RETURNING id
    ), existing_audits AS MATERIALIZED (
      SELECT message.sequence, audit.target_id AS audit_target_id, audit.id::text AS audit_event_id
      FROM input_messages message
      JOIN audit_logs audit
        ON audit.workspace_id = ${scope.workspace_id ?? null}
       AND audit.actor_user_id = ${userId}
       AND audit.action = 'customer_chat_answer'
       AND audit.target_type = 'session'
       AND audit.target_id = message.audit_target_id
      WHERE message.audit_target_id IS NOT NULL
    ), audit_written AS (
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, workspace_id, reason, metadata
      )
      SELECT
        ${userId}, 'customer_chat_answer', 'session', message.audit_target_id,
        ${scope.workspace_id ?? null}, 'live assistant answer persisted',
        jsonb_build_object(
          'generated_by', message.generated_by,
          'resolution_id', message.resolution_id,
          'execution_receipt_id', message.execution_receipt_id,
          'context_packet_id', message.packet_id
        )
      FROM thread_written
      JOIN input_messages message
        ON message.role = 'assistant' AND message.entry_type = 'assistant_answer'
      LEFT JOIN existing_messages existing ON existing.sequence = message.sequence
      WHERE ${scope.workspace_id ?? null}::text IS NOT NULL
        AND message.audit_event_id IS NULL
        AND message.audit_target_id IS NOT NULL
        AND existing.id IS NULL
      ON CONFLICT (workspace_id, actor_user_id, action, target_type, target_id)
        WHERE action = 'customer_chat_answer' AND target_type = 'session'
      DO NOTHING
      RETURNING target_id AS audit_target_id, id::text AS audit_event_id
    ), inserted AS (
      INSERT INTO chat_messages (
        thread_id, role, body, mode, generated_by, grounded_on, grounding_event_ids, receipt_uid,
        interaction_id, entry_type, resolution_id, execution_receipt_id, packet_id,
        operation_event_id, intent_id, audit_event_id, closing_attestation_id
      )
      SELECT
        thread_written.id, message.role, message.body, message.mode, message.generated_by,
        message.grounded_on, message.grounding_event_ids, message.receipt_uid,
        message.interaction_id, message.entry_type, message.resolution_id,
        message.execution_receipt_id, message.packet_id, message.operation_event_id,
        message.intent_id,
        COALESCE(
          message.audit_event_id,
          existing.audit_event_id,
          existing_audits.audit_event_id,
          audit_written.audit_event_id
        ),
        message.closing_attestation_id
      FROM thread_written
      CROSS JOIN input_messages message
      LEFT JOIN existing_messages existing ON existing.sequence = message.sequence
      LEFT JOIN existing_audits ON existing_audits.sequence = message.sequence
      LEFT JOIN audit_written ON audit_written.audit_target_id = message.audit_target_id
      ORDER BY message.sequence
      ON CONFLICT (thread_id, interaction_id, entry_type)
        WHERE interaction_id IS NOT NULL AND entry_type IS NOT NULL
      DO UPDATE SET thread_id = EXCLUDED.thread_id
        WHERE chat_messages.role = EXCLUDED.role
          AND chat_messages.body = EXCLUDED.body
          AND chat_messages.mode IS NOT DISTINCT FROM EXCLUDED.mode
          AND chat_messages.generated_by IS NOT DISTINCT FROM EXCLUDED.generated_by
          AND chat_messages.grounded_on IS NOT DISTINCT FROM EXCLUDED.grounded_on
          AND chat_messages.grounding_event_ids IS NOT DISTINCT FROM EXCLUDED.grounding_event_ids
          AND chat_messages.resolution_id IS NOT DISTINCT FROM EXCLUDED.resolution_id
          AND chat_messages.execution_receipt_id IS NOT DISTINCT FROM EXCLUDED.execution_receipt_id
          AND chat_messages.packet_id IS NOT DISTINCT FROM EXCLUDED.packet_id
          AND chat_messages.operation_event_id IS NOT DISTINCT FROM EXCLUDED.operation_event_id
          AND chat_messages.intent_id IS NOT DISTINCT FROM EXCLUDED.intent_id
          AND chat_messages.audit_event_id IS NOT DISTINCT FROM EXCLUDED.audit_event_id
          AND chat_messages.closing_attestation_id IS NOT DISTINCT FROM EXCLUDED.closing_attestation_id
      RETURNING *
    )
    SELECT *
    FROM inserted
    ORDER BY created_at ASC, id ASC
  `) as Array<Record<string, unknown>>;

  if (rows.length !== valid.length) {
    // A concurrent identical request can win the audit/message uniqueness races after this statement's
    // READ COMMITTED snapshot was taken. One new statement sees the committed rows and converges on their
    // receipts. A genuinely different payload remains a conflict on the second attempt and fails closed.
    if (concurrencyRetry === 0) {
      return appendChatExchangeRow(sql, userId, scope, messages, explicitThreadId, 1);
    }
    if (explicitThreadId) {
      throw makeError('CHAT_THREAD_NOT_FOUND', 'chat thread was not found in this project', 404);
    }
    throw makeError(
      'INTERACTION_ID_CONFLICT',
      'interaction identity was already used for different conversation content',
      409,
    );
  }
  return {
    thread_id: threadId,
    messages: rows.map(normalizeChatMessageRow),
  };
}

function normalizeChatMessageRow(r: Record<string, unknown>): ChatMessageRow {
  return {
    id: String(r.id ?? ''),
    thread_id: String(r.thread_id ?? ''),
    role: r.role === 'assistant' ? 'assistant' : 'you',
    body: String(r.body || ''),
    mode: (r.mode as string) ?? null,
    generated_by: (r.generated_by as string) ?? null,
    grounded_on: r.grounded_on ?? null,
    receipt_uid: r.receipt_uid == null ? null : String(r.receipt_uid),
    interaction_id: r.interaction_id == null ? null : String(r.interaction_id),
    entry_type: (r.entry_type as ChatMessageInput['entry_type']) ?? null,
    resolution_id: r.resolution_id == null ? null : String(r.resolution_id),
    execution_receipt_id: r.execution_receipt_id == null ? null : String(r.execution_receipt_id),
    packet_id: r.packet_id == null ? null : String(r.packet_id),
    operation_event_id: r.operation_event_id == null ? null : String(r.operation_event_id),
    intent_id: r.intent_id == null ? null : String(r.intent_id),
    audit_event_id: r.audit_event_id == null ? null : String(r.audit_event_id),
    closing_attestation_id: r.closing_attestation_id == null ? null : String(r.closing_attestation_id),
    created_at: r.created_at ? new Date(r.created_at as string).toISOString() : '',
  };
}

/** Load a scope's stored thread (oldest → newest), capped. Empty when no thread exists yet. */
export async function listChatHistoryRow(
  sql: Sql,
  userId: string,
  scope: ChatScopeRef,
  limit = 100,
  requestedThreadId: string | null = null,
): Promise<ChatMessageRow[]> {
  if (!userId) return [];
  const scopeKey = chatScopeKey(scope);
  const threadId = String(requestedThreadId || '').trim() || threadIdFor(userId, scopeKey);
  const cap = Math.max(1, Math.min(200, Number(limit) || 100));
  const rows = (await sql/*sql*/`
    SELECT *
    FROM (
      SELECT id, thread_id, role, body, mode, generated_by, grounded_on, receipt_uid,
        interaction_id, entry_type, resolution_id, execution_receipt_id, packet_id,
        operation_event_id, intent_id, audit_event_id, closing_attestation_id, created_at
      FROM chat_messages
      WHERE thread_id = ${threadId}
        AND EXISTS (
          SELECT 1
          FROM chat_threads t
          WHERE t.id = chat_messages.thread_id
            AND t.user_id = ${userId}
            AND t.scope_key = ${scopeKey}
            AND t.workspace_id IS NOT DISTINCT FROM ${scope.workspace_id ?? null}::text
            AND t.project_id IS NOT DISTINCT FROM ${scope.project_id ?? null}::text
            AND t.domain_id IS NOT DISTINCT FROM ${scope.domain_id ?? null}::text
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ${cap}
    ) newest
    ORDER BY created_at ASC, id ASC
  `) as Array<Record<string, unknown>>;
  return rows.map(normalizeChatMessageRow);
}

/** List the authenticated user's threads in one exact scope, newest activity first. */
export async function listChatThreadsRow(
  sql: Sql,
  userId: string,
  scope: ChatScopeRef,
  includeArchived = false,
  limit = 50,
): Promise<ChatThreadRow[]> {
  if (!userId) return [];
  const scopeKey = chatScopeKey(scope);
  const cap = Math.max(1, Math.min(100, Number(limit) || 50));
  const rows = (await sql/*sql*/`
    SELECT
      t.id, t.workspace_id, t.project_id, t.domain_id, t.title, t.title_source,
      t.status, t.created_at, t.updated_at, t.last_message_at, t.archived_at,
      count(m.id)::integer AS message_count
    FROM chat_threads t
    LEFT JOIN chat_messages m ON m.thread_id = t.id
    WHERE t.user_id = ${userId}
      AND t.scope_key = ${scopeKey}
      AND t.workspace_id IS NOT DISTINCT FROM ${scope.workspace_id ?? null}::text
      AND t.project_id IS NOT DISTINCT FROM ${scope.project_id ?? null}::text
      AND t.domain_id IS NOT DISTINCT FROM ${scope.domain_id ?? null}::text
      AND (${includeArchived}::boolean OR COALESCE(t.status, 'active') = 'active')
    GROUP BY t.id
    ORDER BY COALESCE(t.last_message_at, t.updated_at, t.created_at) DESC, t.id DESC
    LIMIT ${cap}
  `) as Array<Record<string, unknown>>;
  return rows.map(normalizeChatThreadRow);
}

/** Create a new explicit thread. The legacy deterministic thread is created only by legacy calls. */
export async function createChatThreadRow(
  sql: Sql,
  userId: string,
  scope: ChatScopeRef,
  requestedTitle: string | null = null,
): Promise<ChatThreadWriteReceipt> {
  if (!userId) throw makeError('VALIDATION_ERROR', 'user_id is required', 400);
  const title = String(requestedTitle || '').trim() || 'New chat';
  if (title.length > 120) throw makeError('VALIDATION_ERROR', 'title must be at most 120 characters', 400);
  const id = `thr_${crypto.randomUUID().replace(/-/g, '')}`;
  const scopeKey = chatScopeKey(scope);
  const rows = (await sql/*sql*/`
    WITH thread_written AS (
      INSERT INTO chat_threads (
        id, user_id, workspace_id, project_id, domain_id, scope_key,
        title, title_source, status, last_message_at
      )
      VALUES (
        ${id}, ${userId}, ${scope.workspace_id ?? null}, ${scope.project_id ?? null},
        ${scope.domain_id ?? null}, ${scopeKey}, ${title},
        ${requestedTitle ? 'manual' : 'default'}, 'active', now()
      )
      RETURNING *
    ), audit_written AS (
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, workspace_id, reason, metadata
      )
      SELECT
        ${userId}, 'chat_thread_create', 'chat_thread', thread_written.id,
        thread_written.workspace_id, 'project conversation created',
        jsonb_build_object(
          'project_id', thread_written.project_id,
          'domain_id', thread_written.domain_id,
          'title_source', thread_written.title_source
        )
      FROM thread_written
      RETURNING id::text AS audit_event_id
    )
    SELECT thread_written.*, 0::integer AS message_count, audit_written.audit_event_id
    FROM thread_written CROSS JOIN audit_written
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw makeError('CHAT_THREAD_CREATE_FAILED', 'chat thread could not be created', 503);
  const auditEventId = String(row.audit_event_id || '');
  return {
    thread: normalizeChatThreadRow(row),
    receipt_id: `chat-thread-create:${id}:${auditEventId}`,
    audit_event_id: auditEventId,
  };
}

/** Rename, archive, or restore a thread owned by this user in this exact scope. */
export async function updateChatThreadRow(
  sql: Sql,
  userId: string,
  scope: ChatScopeRef,
  threadId: string,
  input: { title?: string; status?: ChatThreadStatus },
): Promise<ChatThreadWriteReceipt | null> {
  if (!userId) throw makeError('VALIDATION_ERROR', 'user_id is required', 400);
  const id = String(threadId || '').trim();
  if (!/^thr_[a-zA-Z0-9_|-]{8,200}$/.test(id)) throw makeError('VALIDATION_ERROR', 'thread_id is invalid', 400);
  const hasTitle = typeof input.title === 'string';
  const title = hasTitle ? String(input.title).trim() : '';
  if (hasTitle && (!title || title.length > 120)) {
    throw makeError('VALIDATION_ERROR', 'title must be 1-120 characters', 400);
  }
  const hasStatus = input.status === 'active' || input.status === 'archived';
  if (!hasTitle && !hasStatus) throw makeError('VALIDATION_ERROR', 'thread mutation is empty', 400);
  const scopeKey = chatScopeKey(scope);
  const action = hasStatus ? (input.status === 'archived' ? 'chat_thread_archive' : 'chat_thread_restore') : 'chat_thread_rename';
  const rows = (await sql/*sql*/`
    WITH thread_updated AS (
      UPDATE chat_threads
      SET
        title = CASE WHEN ${hasTitle}::boolean THEN ${title}::text ELSE title END,
        title_source = CASE WHEN ${hasTitle}::boolean THEN 'manual' ELSE title_source END,
        status = CASE WHEN ${hasStatus}::boolean THEN ${input.status ?? null}::text ELSE status END,
        archived_at = CASE
          WHEN ${hasStatus}::boolean AND ${input.status ?? null}::text = 'archived' THEN now()
          WHEN ${hasStatus}::boolean AND ${input.status ?? null}::text = 'active' THEN NULL
          ELSE archived_at
        END,
        updated_at = now()
      WHERE id = ${id}
        AND user_id = ${userId}
        AND scope_key = ${scopeKey}
        AND workspace_id IS NOT DISTINCT FROM ${scope.workspace_id ?? null}::text
        AND project_id IS NOT DISTINCT FROM ${scope.project_id ?? null}::text
        AND domain_id IS NOT DISTINCT FROM ${scope.domain_id ?? null}::text
      RETURNING *
    ), audit_written AS (
      INSERT INTO audit_logs (
        actor_user_id, action, target_type, target_id, workspace_id, reason, metadata
      )
      SELECT
        ${userId}, ${action}, 'chat_thread', thread_updated.id,
        thread_updated.workspace_id, 'project conversation lifecycle updated',
        jsonb_build_object(
          'project_id', thread_updated.project_id,
          'status', thread_updated.status,
          'title_source', thread_updated.title_source
        )
      FROM thread_updated
      RETURNING id::text AS audit_event_id
    )
    SELECT thread_updated.*,
      (SELECT count(*)::integer FROM chat_messages m WHERE m.thread_id = thread_updated.id) AS message_count,
      audit_written.audit_event_id
    FROM thread_updated CROSS JOIN audit_written
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const auditEventId = String(row.audit_event_id || '');
  return {
    thread: normalizeChatThreadRow(row),
    receipt_id: `chat-thread-update:${id}:${auditEventId}`,
    audit_event_id: auditEventId,
  };
}

/** W2 (260708) · receipt lookup: the message + its thread's tenancy, keyed on the opaque receipt_uid.
 *  Returns null when absent OR pre-058 (degrade-safe) — the route renders both as the same 404. */
export interface ReceiptMessageRow {
  workspace_id: string | null;
  thread_user_id: string;
  role: string;
  body: string;
  mode: string | null;
  generated_by: string | null;
  grounded_on: unknown;
  grounding_event_ids: string[] | null;
  interaction_id: string | null;
  resolution_id: string | null;
  execution_receipt_id: string | null;
  packet_id: string | null;
  audit_event_id: string | null;
  created_at: string | null;
}
export async function getMessageByReceiptUidRow(sql: Sql, receiptUid: string): Promise<ReceiptMessageRow | null> {
  const uid = String(receiptUid || '').trim();
  if (!uid) return null;
  try {
    const rows = (await sql/*sql*/`
      SELECT t.workspace_id, t.user_id AS thread_user_id, m.role, m.body, m.mode, m.generated_by,
             m.grounded_on, m.grounding_event_ids, m.interaction_id, m.resolution_id,
             m.execution_receipt_id, m.packet_id, m.audit_event_id, m.created_at
      FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
      WHERE m.receipt_uid = ${uid} LIMIT 1
    `) as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) return null;
    return {
      workspace_id: r.workspace_id == null ? null : String(r.workspace_id),
      thread_user_id: String(r.thread_user_id ?? ''),
      role: String(r.role ?? ''),
      body: String(r.body ?? ''),
      mode: r.mode == null ? null : String(r.mode),
      generated_by: r.generated_by == null ? null : String(r.generated_by),
      grounded_on: r.grounded_on ?? null,
      grounding_event_ids: Array.isArray(r.grounding_event_ids) ? (r.grounding_event_ids as string[]) : null,
      interaction_id: r.interaction_id == null ? null : String(r.interaction_id),
      resolution_id: r.resolution_id == null ? null : String(r.resolution_id),
      execution_receipt_id: r.execution_receipt_id == null ? null : String(r.execution_receipt_id),
      packet_id: r.packet_id == null ? null : String(r.packet_id),
      audit_event_id: r.audit_event_id == null ? null : String(r.audit_event_id),
      created_at: r.created_at == null ? null : new Date(r.created_at as string).toISOString(),
    };
  } catch (err) {
    // DISCLOSURE (260806): a failed receipt lookup otherwise renders as a clean 404 "receipt not
    // found" — an infrastructure error wearing a definitive answer. Degrade kept; now observable.
    console.log(JSON.stringify({ kind: 'degraded_read_disclosed', surface: 'chat_receipt_lookup', error: String((err as Error)?.message || err).slice(0, 160) }));
    return null; /* pre-058 schema */
  }
}
