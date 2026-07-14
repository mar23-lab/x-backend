// prompt-tags-store.ts · durable per-operator quick-action chips (W2).
//
// Authority: 025_prompt_tags. GLOBAL per user (one set across all scopes). The id is deterministic
// (user_id:tag_id) so upsert is idempotent — add + edit are the SAME write. message is hard-capped at
// 600 chars here (defense in depth before W4's LLM ever sees it). All reads/writes scoped to the
// calling operator's user_id. Best-effort at the call site (a missing table never breaks the chat).

import type { Sql } from '../db/client';

export interface PromptTagRow {
  tag_id: string;
  label: string;
  message: string;
  sort: number;
  updated_at: string;
}

export interface UpsertPromptTagInput {
  user_id: string;
  tag_id: string;
  label: string;
  message: string;
  sort?: number;
}

const str = (v: unknown): string => (v == null ? '' : String(v));
const MESSAGE_CAP = 600;
const LABEL_CAP = 64;

function mapRow(r: Record<string, unknown>): PromptTagRow {
  return {
    tag_id: str(r.tag_id),
    label: str(r.label),
    message: str(r.message),
    sort: Number(r.sort) || 0,
    updated_at: r.updated_at ? new Date(r.updated_at as string).toISOString() : '',
  };
}

/** List the operator's stored prompt tags, in sort order. Empty when nothing stored yet. */
export async function listPromptTagsForUserRow(sql: Sql, userId: string): Promise<PromptTagRow[]> {
  const uid = str(userId).trim();
  if (!uid) return [];
  const rows = (await sql/*sql*/`
    SELECT tag_id, label, message, sort, updated_at
    FROM prompt_tags
    WHERE user_id = ${uid} AND deleted_at IS NULL
    ORDER BY sort ASC, updated_at DESC
  `) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

/** Add OR edit a tag (same write — deterministic id). Returns the stored row. Caps label + message. */
export async function upsertPromptTagForUserRow(sql: Sql, input: UpsertPromptTagInput): Promise<PromptTagRow | null> {
  const uid = str(input.user_id).trim();
  const tagId = str(input.tag_id).trim();
  const label = str(input.label).trim().slice(0, LABEL_CAP);
  const message = str(input.message).trim().slice(0, MESSAGE_CAP);
  if (!uid || !tagId || !label || !message) return null;
  const id = `${uid}:${tagId}`;
  const sort = Number.isFinite(input.sort) ? Number(input.sort) : 0;
  const rows = (await sql/*sql*/`
    INSERT INTO prompt_tags (id, user_id, tag_id, label, message, sort, updated_at)
    VALUES (${id}, ${uid}, ${tagId}, ${label}, ${message}, ${sort}, now())
    ON CONFLICT (user_id, tag_id) DO UPDATE SET
      label = EXCLUDED.label, message = EXCLUDED.message, sort = EXCLUDED.sort,
      deleted_at = NULL, updated_at = now()  -- 044 · re-adding a soft-deleted tag revives it
    RETURNING tag_id, label, message, sort, updated_at
  `) as Array<Record<string, unknown>>;
  return rows.length > 0 ? mapRow(rows[0]!) : null;
}

/** Bulk upsert (the one-time localStorage → server migration on first load). Returns the count written. */
export async function bulkUpsertPromptTagsForUserRow(
  sql: Sql,
  userId: string,
  tags: Array<{ tag_id?: string; id?: string; label?: string; message?: string }>,
): Promise<number> {
  const list = Array.isArray(tags) ? tags : [];
  let n = 0;
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i]!;
    const tagId = str(t.tag_id || t.id).trim();
    if (!tagId) continue;
    const out = await upsertPromptTagForUserRow(sql, {
      user_id: userId, tag_id: tagId, label: str(t.label), message: str(t.message), sort: i,
    });
    if (out) n += 1;
  }
  return n;
}

/** Delete one of the operator's tags. Returns true if a row was removed. */
export async function deletePromptTagForUserRow(sql: Sql, userId: string, tagId: string): Promise<boolean> {
  const uid = str(userId).trim();
  const tid = str(tagId).trim();
  if (!uid || !tid) return false;
  // 044 · SOFT delete: mark deleted_at so the tag is recoverable (re-adding the same tag_id revives
  // it via the upsert ON CONFLICT). Reads filter `deleted_at IS NULL`.
  const rows = (await sql/*sql*/`
    UPDATE prompt_tags SET deleted_at = now(), updated_at = now()
    WHERE user_id = ${uid} AND tag_id = ${tid} AND deleted_at IS NULL RETURNING tag_id
  `) as Array<Record<string, unknown>>;
  return rows.length > 0;
}
