// chat-store.ts · cockpit chat thread persistence (Wave 3) · cross-browser continuity.
//
// Authority: 020_cockpit_chat_threads. ONE thread per (operator, scope); messages appended in order.
// The thread id is DETERMINISTIC from (user_id, scope_key) so the same operator returning to the same
// scope re-opens the same thread (idempotent upsert) — that is what makes a conversation survive a
// reload or a different browser. Legacy routes may treat persistence as best-effort; commercial pilot
// routes can require this append before returning a successful answer.

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

const MAX_BODY = 8000;
const norm = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Normalized scope identity — must be stable for the same workspace/project/domain. */
export function chatScopeKey(scope: ChatScopeRef): string {
  return [norm(scope.workspace_id), norm(scope.project_id), norm(scope.domain_id)].join('|');
}

/** Deterministic thread id per (user, scope) so the same operator+scope reuses one thread. */
function threadIdFor(userId: string, scopeKey: string): string {
  return ('thr_' + norm(userId) + '__' + scopeKey).slice(0, 200);
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
): Promise<ChatExchangeWriteResult> {
  const valid = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && (m.role === 'you' || m.role === 'assistant') && typeof m.body === 'string' && m.body.trim(),
  );
  if (!valid.length) return { thread_id: threadIdFor(userId, chatScopeKey(scope)), messages: [] };
  if (!userId) throw makeError('VALIDATION_ERROR', 'user_id is required', 400);

  const scopeKey = chatScopeKey(scope);
  const threadId = threadIdFor(userId, scopeKey);
  const payload = valid.map((m, sequence) => {
    const links = Array.isArray(m.grounding_event_ids) && m.role === 'assistant'
      ? m.grounding_event_ids.filter((x) => typeof x === 'string' && x).slice(0, 200)
      : null;
    return {
      sequence,
      role: m.role,
      body: String(m.body).slice(0, MAX_BODY),
      mode: m.mode ?? null,
      generated_by: m.generated_by ?? null,
      grounded_on: m.grounded_on ?? null,
      grounding_event_ids: links,
      receipt_uid: links?.length ? `rcpt_${crypto.randomUUID().replace(/-/g, '')}` : null,
      interaction_id: m.interaction_id ?? null,
      entry_type: m.entry_type ?? null,
      resolution_id: m.resolution_id ?? null,
      execution_receipt_id: m.execution_receipt_id ?? null,
      packet_id: m.packet_id ?? null,
      operation_event_id: m.operation_event_id ?? null,
      intent_id: m.intent_id ?? null,
      audit_event_id: m.audit_event_id ?? null,
      closing_attestation_id: m.closing_attestation_id ?? null,
    };
  });

  const rows = (await sql/*sql*/`
    WITH thread_written AS (
      INSERT INTO chat_threads (id, user_id, workspace_id, project_id, domain_id, scope_key)
      VALUES (
        ${threadId}, ${userId}, ${scope.workspace_id ?? null}, ${scope.project_id ?? null},
        ${scope.domain_id ?? null}, ${scopeKey}
      )
      ON CONFLICT (id) DO UPDATE SET updated_at = now()
      RETURNING id
    ), input_messages AS MATERIALIZED (
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
        closing_attestation_id text
      )
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
        message.intent_id, message.audit_event_id, message.closing_attestation_id
      FROM thread_written
      CROSS JOIN input_messages message
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
): Promise<ChatMessageRow[]> {
  if (!userId) return [];
  const threadId = threadIdFor(userId, chatScopeKey(scope));
  const cap = Math.max(1, Math.min(200, Number(limit) || 100));
  const rows = (await sql/*sql*/`
    SELECT *
    FROM (
      SELECT id, thread_id, role, body, mode, generated_by, grounded_on, receipt_uid,
        interaction_id, entry_type, resolution_id, execution_receipt_id, packet_id,
        operation_event_id, intent_id, audit_event_id, closing_attestation_id, created_at
      FROM chat_messages
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${cap}
    ) newest
    ORDER BY created_at ASC, id ASC
  `) as Array<Record<string, unknown>>;
  return rows.map(normalizeChatMessageRow);
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
  created_at: string | null;
}
export async function getMessageByReceiptUidRow(sql: Sql, receiptUid: string): Promise<ReceiptMessageRow | null> {
  const uid = String(receiptUid || '').trim();
  if (!uid) return null;
  try {
    const rows = (await sql/*sql*/`
      SELECT t.workspace_id, t.user_id AS thread_user_id, m.role, m.body, m.mode, m.generated_by,
             m.grounded_on, m.grounding_event_ids, m.created_at
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
      created_at: r.created_at == null ? null : new Date(r.created_at as string).toISOString(),
    };
  } catch (err) {
    // DISCLOSURE (260806): a failed receipt lookup otherwise renders as a clean 404 "receipt not
    // found" — an infrastructure error wearing a definitive answer. Degrade kept; now observable.
    console.log(JSON.stringify({ kind: 'degraded_read_disclosed', surface: 'chat_receipt_lookup', error: String((err as Error)?.message || err).slice(0, 160) }));
    return null; /* pre-058 schema */
  }
}
