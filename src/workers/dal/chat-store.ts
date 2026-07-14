// chat-store.ts · cockpit chat thread persistence (Wave 3) · cross-browser continuity.
//
// Authority: 020_cockpit_chat_threads. ONE thread per (operator, scope); messages appended in order.
// The thread id is DETERMINISTIC from (user_id, scope_key) so the same operator returning to the same
// scope re-opens the same thread (idempotent upsert) — that is what makes a conversation survive a
// reload or a different browser. Best-effort by design at the route: a persist failure never breaks
// the live answer.

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
  /** W1 (260708) · live links to the operation_events that grounded this answer (migration 058). The route
   *  supplies these only when CHAT_RECEIPT_GROUNDING_ENABLED — absent = legacy insert, byte-identical. */
  grounding_event_ids?: string[] | null;
}

export interface ChatMessageRow {
  role: 'you' | 'assistant';
  body: string;
  mode: string | null;
  generated_by: string | null;
  grounded_on: unknown;
  created_at: string;
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
): Promise<void> {
  const valid = (Array.isArray(messages) ? messages : []).filter(
    (m) => m && (m.role === 'you' || m.role === 'assistant') && typeof m.body === 'string' && m.body.trim(),
  );
  if (!valid.length) return;
  const threadId = await getOrCreateChatThreadRow(sql, userId, scope);
  for (const m of valid) {
    const links = Array.isArray(m.grounding_event_ids)
      ? m.grounding_event_ids.filter((x) => typeof x === 'string' && x).slice(0, 200)
      : null;
    if (links && links.length && m.role === 'assistant') {
      // W1 receipt substrate (migration 058): persist the live event links + mint the opaque receipt key.
      // Degrade-safe: a pre-058 schema (missing columns) falls back to the legacy insert — the answer's
      // persistence never depends on the receipt columns existing.
      const receiptUid = `rcpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
      try {
        await sql/*sql*/`
          INSERT INTO chat_messages (thread_id, role, body, mode, generated_by, grounded_on, grounding_event_ids, receipt_uid)
          VALUES (
            ${threadId}, ${m.role}, ${String(m.body).slice(0, MAX_BODY)}, ${m.mode ?? null},
            ${m.generated_by ?? null}, ${m.grounded_on != null ? JSON.stringify(m.grounded_on) : null},
            ${links}, ${receiptUid}
          )
        `;
        continue;
      } catch { /* fall through to the legacy insert (pre-058 schema) */ }
    }
    await sql/*sql*/`
      INSERT INTO chat_messages (thread_id, role, body, mode, generated_by, grounded_on)
      VALUES (
        ${threadId}, ${m.role}, ${String(m.body).slice(0, MAX_BODY)}, ${m.mode ?? null},
        ${m.generated_by ?? null}, ${m.grounded_on != null ? JSON.stringify(m.grounded_on) : null}
      )
    `;
  }
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
    SELECT role, body, mode, generated_by, grounded_on, created_at
    FROM chat_messages
    WHERE thread_id = ${threadId}
    ORDER BY created_at ASC, id ASC
    LIMIT ${cap}
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    role: r.role === 'assistant' ? 'assistant' : 'you',
    body: String(r.body || ''),
    mode: (r.mode as string) ?? null,
    generated_by: (r.generated_by as string) ?? null,
    grounded_on: r.grounded_on ?? null,
    created_at: r.created_at ? new Date(r.created_at as string).toISOString() : '',
  }));
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
  } catch { return null; /* pre-058 schema */ }
}
