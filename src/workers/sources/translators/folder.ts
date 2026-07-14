// folder.ts · the reflection-only folder translator + on-demand sync orchestrator (W3).
//
// A folder change (add/modify/delete) -> a contract-enforced operation_event, flowing through the SAME
// spine as every other source. Reuses the github translator's mapping shape + enforceContract
// (DEFAULT_R50_3A_CONTRACT: reflection_only + 200-byte cap) verbatim. The server NEVER reads a
// filesystem — the operator's client posts a snapshot; this diffs it against the durable baseline
// (folder-snapshot-store) and emits one event per change, then stores the new baseline. Idempotent:
// the event id is deterministic from (binding, change-kind, path, checksum), and re-posting an
// unchanged snapshot diffs to zero, so a double-sync emits nothing.

import type { DalAdapter } from '../../dal/DalAdapter';
import type { HarnessFlowEventInput } from '../../dal/types/event';
import { enforceContract, DEFAULT_R50_3A_CONTRACT } from '../contract-enforcer';
import { diffFolderSnapshots, type FolderFile, type FolderDiff } from '../folder-snapshot-core';

export type FolderChangeKind = 'added' | 'modified' | 'removed';

export interface FolderBinding {
  binding_id: string;
  workspace_id: string;
  project_id: string | null;
  path: string | null;
  domain_id?: string | null;
}

export interface FolderSyncResult {
  emitted: number;
  rejected: number;
  added: number;
  modified: number;
  removed: number;
}

const slug = (s: string): string => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const folderLabel = (path: string | null): string => {
  const p = String(path || 'folder');
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
};

/** Map one folder change into a contract-shaped operation_event. Deterministic, idempotent id. */
// Vocabulary bridge (2026-06-10 audit fix · IA-plan dedup #5): the BINDING kind is
// `desktop_folder` (project_source_bindings.source_kind); the EVENT this connector emits is
// tagged with the source_tool `folder`. They are two layers, single-sourced here so the
// relationship is explicit (not "two unbridged names").
export const FOLDER_BINDING_SOURCE_KIND = 'desktop_folder' as const;
export const FOLDER_EVENT_SOURCE_TOOL = 'folder' as const;

export function folderChangeToEvent(
  binding: FolderBinding,
  kind: FolderChangeKind,
  file: FolderFile,
  occurredAtIso: string,
): HarnessFlowEventInput {
  const checksum8 = String(file.checksum || '').slice(0, 8);
  const verb = kind === 'added' ? 'added' : kind === 'modified' ? 'changed' : 'removed';
  return {
    id: `evt-folder-${slug(binding.binding_id)}-${kind}-${slug(file.path)}-${checksum8}`,
    source_tool: FOLDER_EVENT_SOURCE_TOOL,
    agent_id: `folder:${String(file.path).slice(0, 80)}`,
    project_id: binding.project_id,
    intent_id: null,
    status: 'completed',
    summary: `[${folderLabel(binding.path)}] ${String(file.path).slice(0, 150)} · ${verb}`,
    body: null, // reflection_only — metadata only, never file content
    evidence_link: String(file.path).slice(0, 400),
    visibility: 'internal_workspace',
    occurred_at: occurredAtIso,
    domain_id: binding.domain_id ?? null,
  };
}

/**
 * ARCH-006 W6 · folder→packet linker. Promote one folder change into a GOVERNANCE PACKET envelope (the
 * shape materializeGovernanceSnapshotRow consumes → an operations_unified plane='governance' row → a
 * `packet` node on the board + chat governance plane + the data-graph). OPERATOR-INITIATED ("make a
 * review packet from this change") — NOT automatic, so the reflection-only/observe-never-act contract of
 * the connector is preserved. The title carries "Review" + state='needs_review' so classifyGovernanceRow
 * (cockpit-chat) classifies it `needsrev` → approval_state 'pending' (it lands in the operator's queue).
 * Deterministic row_id (folderpkt-*) — re-promoting the same change is an idempotent upsert + distinct
 * from the reflection_only event id (evt-folder-*), so promotion never collides with the activity event.
 */
export function folderChangeToPacketRow(
  binding: FolderBinding,
  kind: FolderChangeKind,
  file: FolderFile,
  occurredAtIso: string,
): Record<string, unknown> {
  const checksum8 = String(file.checksum || '').slice(0, 8);
  const verb = kind === 'added' ? 'added' : kind === 'modified' ? 'changed' : 'removed';
  const label = folderLabel(binding.path);
  return {
    row_id: `folderpkt-${slug(binding.binding_id)}-${kind}-${slug(file.path)}-${checksum8}`,
    stream_type: 'folder_change_review',
    state: 'needs_review',
    workspace_id: binding.workspace_id,
    project_id: binding.project_id ?? '',
    domain_id: binding.domain_id ?? '',
    title: `Review folder change · ${label} · ${String(file.path).slice(0, 150)} ${verb}`,
    summary: `A folder change (${verb}) needs your review before it is accepted into the project record.`,
    timestamp_iso: occurredAtIso,
    source_adapter: FOLDER_EVENT_SOURCE_TOOL,
    evidence_refs: [{ uri: String(file.path).slice(0, 400), label: 'folder path' }],
  };
}

/** Build the (kind, file) change list from a diff, in a stable order: added, modified, removed. */
export function diffToChanges(d: FolderDiff): Array<{ kind: FolderChangeKind; file: FolderFile }> {
  return [
    ...d.added.map((file) => ({ kind: 'added' as const, file })),
    ...d.modified.map((file) => ({ kind: 'modified' as const, file })),
    ...d.removed.map((file) => ({ kind: 'removed' as const, file })),
  ];
}

/**
 * On-demand sync: diff the posted snapshot against the stored baseline, emit one contract-enforced
 * event per change (reflection_only), then store the new baseline. Returns counts. Each emit is
 * best-effort/contract-gated; a single bad event never aborts the run.
 */
export async function syncFolderSnapshot(
  dal: DalAdapter,
  binding: FolderBinding,
  currentFiles: FolderFile[],
  occurredAtIso: string,
): Promise<FolderSyncResult> {
  const baseline = await dal.getFolderBaseline(binding.binding_id);
  const diff = diffFolderSnapshots(baseline, currentFiles);
  const changes = diffToChanges(diff);

  let emitted = 0;
  let rejected = 0;
  for (const { kind, file } of changes) {
    const event = folderChangeToEvent(binding, kind, file, occurredAtIso);
    const verdict = enforceContract(event, DEFAULT_R50_3A_CONTRACT);
    if (!verdict.ok) { rejected += 1; continue; }
    try {
      await dal.upsertEvent(binding.workspace_id, verdict.event);
      emitted += 1;
    } catch (_) { rejected += 1; }
  }

  // Store the new baseline so the NEXT sync diffs against this state (idempotent on binding_id).
  await dal.putFolderBaseline({
    binding_id: binding.binding_id,
    workspace_id: binding.workspace_id,
    project_id: binding.project_id,
    path: binding.path,
    files: currentFiles,
  });

  return { emitted, rejected, added: diff.added.length, modified: diff.modified.length, removed: diff.removed.length };
}
