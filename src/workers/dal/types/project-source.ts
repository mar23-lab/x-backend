import type { ProjectId, UserId, WorkspaceId } from './identity';

export type ProjectSourceKind =
  | 'github_repo'
  | 'google_drive_folder'
  | 'desktop_folder'
  | 'manual';

export type ProjectSourceBindingStatus =
  | 'pending_auth'
  | 'connected'
  | 'reconnect_required'
  | 'disabled_preview'
  | 'archived';

export type ProjectSourceReadPolicy =
  | 'metadata_only'
  | 'proposal_only'
  | 'read_only';

export interface ProjectSourceBinding {
  id: string;
  binding_id: string;
  workspace_id: WorkspaceId;
  project_id: ProjectId;
  source_kind: ProjectSourceKind;
  // W1'-PR4 (ADR-V3-026 / migration 033) · nullable synthetic_domains lens this source feeds;
  // NULL = the prior project-only binding (unchanged).
  domain_id: string | null;
  user_source_connection_id: string | null;
  source_ref: Record<string, unknown>;
  status: ProjectSourceBindingStatus;
  read_policy: ProjectSourceReadPolicy;
  connected_by: UserId | null;
  connected_at: string | null;
  last_verified_at: string | null;
  reconnect_required_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // R57 folders-into-workspace Phase 2 (2026-06-11): folder-management facts LEFT-JOINed from
  // folder_snapshots for desktop_folder bindings, so the per-project sources list shows file-count
  // + last-synced (the parity the standalone Folders screen used to provide). Null for non-folder
  // kinds and for a folder with no baseline yet.
  folder_file_count?: number | null;
  folder_synced_at?: string | null;
}

export interface ProjectSourceBindingInput {
  source_kind: ProjectSourceKind;
  // W1'-PR4 · optional lens to attach this source to (synthetic_domains.id). Omit for project-only.
  domain_id?: string | null;
  user_source_connection_id?: string | null;
  source_ref?: Record<string, unknown>;
  status?: ProjectSourceBindingStatus;
  read_policy?: ProjectSourceReadPolicy;
  reconnect_required_reason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProjectSourceBindingPatch {
  source_ref?: Record<string, unknown>;
  status?: ProjectSourceBindingStatus;
  read_policy?: ProjectSourceReadPolicy;
  reconnect_required_reason?: string | null;
  metadata?: Record<string, unknown>;
}
