import { makeError } from './shared-helpers';
import type { Sql } from '../db/client';
import type {
  ChatScopeRef,
  ChatThreadRow,
  ChatThreadStatus,
  ChatThreadTitleSource,
  ChatThreadWriteReceipt,
} from './chat-store';

const norm = (value: unknown): string => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function scopeKeyFor(scope: ChatScopeRef): string {
  return [norm(scope.workspace_id), norm(scope.project_id), norm(scope.domain_id)].join('|');
}

function normalizeChatThreadRow(row: Record<string, unknown>): ChatThreadRow {
  return {
    id: String(row.id ?? ''),
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    project_id: row.project_id == null ? null : String(row.project_id),
    domain_id: row.domain_id == null ? null : String(row.domain_id),
    title: String(row.title || 'New chat'),
    title_source: (['default', 'auto', 'manual', 'legacy'].includes(String(row.title_source))
      ? String(row.title_source) : 'default') as ChatThreadTitleSource,
    status: row.status === 'archived' ? 'archived' : 'active',
    message_count: Number(row.message_count ?? 0),
    created_at: row.created_at ? new Date(row.created_at as string).toISOString() : '',
    updated_at: row.updated_at ? new Date(row.updated_at as string).toISOString() : '',
    last_message_at: row.last_message_at
      ? new Date(row.last_message_at as string).toISOString()
      : (row.updated_at ? new Date(row.updated_at as string).toISOString() : ''),
    archived_at: row.archived_at ? new Date(row.archived_at as string).toISOString() : null,
  };
}

export async function listChatThreadsRow(
  sql: Sql,
  userId: string,
  scope: ChatScopeRef,
  includeArchived = false,
  limit = 50,
): Promise<ChatThreadRow[]> {
  if (!userId) return [];
  const scopeKey = scopeKeyFor(scope);
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
  const scopeKey = scopeKeyFor(scope);
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
  const scopeKey = scopeKeyFor(scope);
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
