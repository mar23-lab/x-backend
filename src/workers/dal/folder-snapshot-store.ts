// folder-snapshot-store.ts · the durable per-binding folder baseline (W3).
//
// Authority: 026_folder_source. One row per folder binding holds the last-synced snapshot (files +
// checksums); the next sync diffs against it (folder-snapshot-core) and stores the new one. Best-effort
// at the call site — a missing table (026 not applied) means an empty baseline, so the FIRST sync just
// emits every file as "added", which is the correct behaviour.

import type { Sql } from '../db/client';
import { normalizeFolderSnapshot, type FolderSnapshot } from '../sources/folder-snapshot-core';

export interface PutFolderBaselineInput {
  binding_id: string;
  workspace_id: string | null;
  project_id: string | null;
  path: string | null;
  files: FolderSnapshot;
}

export interface FolderBindingSummary {
  binding_id: string;
  workspace_id: string | null;
  project_id: string | null;
  path: string | null;
  file_count: number;
  synced_at: string;
}

/** The canonical scope a folder binding carries (sourced from the baseline at register time). */
export interface FolderBindingMeta {
  workspace_id: string | null;
  project_id: string | null;
  path: string | null;
}

const str = (v: unknown): string => (v == null ? '' : String(v));

/** Read the stored baseline file list for a binding. [] when none stored yet (first sync). */
export async function getFolderBaselineRow(sql: Sql, bindingId: string): Promise<FolderSnapshot> {
  const id = str(bindingId).trim();
  if (!id) return [];
  const rows = (await sql/*sql*/`
    SELECT files FROM folder_snapshots WHERE binding_id = ${id} LIMIT 1
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  return normalizeFolderSnapshot(rows[0]!.files);
}

/**
 * List the operator's folder bindings, newest first. Phase D (ADR-XLOOP-IA-001): the CANONICAL registry
 * is `project_source_bindings` (source_kind='desktop_folder'); `folder_snapshots` is LEFT-JOINed only for
 * the diff-baseline facts (file_count + last sync). This kills the parallel-registry duplication —
 * folder_snapshots no longer doubles as the registry.
 */
export async function listFolderBindingsForOperatorRow(sql: Sql, workspaceIds: string[]): Promise<FolderBindingSummary[]> {
  const ids = (Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds]).filter(Boolean);
  if (ids.length === 0) return [];
  const rows = (await sql/*sql*/`
    SELECT psb.id AS binding_id, psb.workspace_id, psb.project_id,
           (psb.source_ref->>'path') AS path,
           COALESCE(jsonb_array_length(COALESCE(fs.files, '[]'::jsonb)), 0) AS file_count,
           fs.synced_at
    FROM project_source_bindings psb
    LEFT JOIN folder_snapshots fs ON fs.binding_id = psb.id
    WHERE psb.workspace_id = ANY(${ids})
      AND psb.source_kind = 'desktop_folder'
      AND psb.status <> 'archived'
    ORDER BY psb.created_at DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    binding_id: str(r.binding_id),
    workspace_id: r.workspace_id == null ? null : str(r.workspace_id),
    project_id: r.project_id == null ? null : str(r.project_id),
    path: r.path == null ? null : str(r.path),
    file_count: Number(r.file_count) || 0,
    synced_at: r.synced_at ? new Date(r.synced_at as string).toISOString() : '',
  }));
}

/**
 * Read the canonical scope (workspace/project/path) a binding carries, from the baseline written at
 * register time. Phase D: sync uses this so folder events are correctly project-scoped even when the
 * local sync CLI omits project_id (HR-SCOPE-INTEGRITY). null when no baseline row exists yet.
 */
export async function getFolderBindingMetaRow(sql: Sql, bindingId: string): Promise<FolderBindingMeta | null> {
  const id = str(bindingId).trim();
  if (!id) return null;
  const rows = (await sql/*sql*/`
    SELECT workspace_id, project_id, path FROM folder_snapshots WHERE binding_id = ${id} LIMIT 1
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    workspace_id: r.workspace_id == null ? null : str(r.workspace_id),
    project_id: r.project_id == null ? null : str(r.project_id),
    path: r.path == null ? null : str(r.path),
  };
}

/** Upsert the baseline for a binding (idempotent on binding_id). Stores the canonical normalized list. */
export async function putFolderBaselineRow(sql: Sql, input: PutFolderBaselineInput): Promise<void> {
  const id = str(input.binding_id).trim();
  if (!id) return;
  const files = JSON.stringify(normalizeFolderSnapshot(input.files));
  await sql/*sql*/`
    INSERT INTO folder_snapshots (binding_id, workspace_id, project_id, path, files, synced_at)
    VALUES (${id}, ${input.workspace_id}, ${input.project_id}, ${input.path}, ${files}::jsonb, now())
    ON CONFLICT (binding_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id, project_id = EXCLUDED.project_id,
      path = EXCLUDED.path, files = EXCLUDED.files, synced_at = now()
  `;
}
