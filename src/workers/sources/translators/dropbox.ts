// translators/dropbox.ts · R50.3c · 2026-05-28
//
// Authority: R50 plan stage R50.3c · CLERK_OAUTH_PROVIDER_CONFIG.md
//
// Pulls Dropbox folder + file METADATA recursively from the user's root.
// Emits operation_events with source_tool='dropbox'. Never invokes any
// content-download endpoint.
//
// API SURFACE USED:
//   POST /2/files/list_folder           · initial listing (path="" = root)
//   POST /2/files/list_folder/continue  · pagination via cursor
//
// SCOPES REQUIRED (configured in Clerk dashboard):
//   files.metadata.read · account_info.read
//
// RATE LIMIT:
//   Dropbox returns 429 with Retry-After header on app-tier exhaustion.
//   R50.3c stops on 429; R50.3d adds backoff.
//
// CONTRACT INVARIANT:
//   Per-event enforceContract() before DAL.upsertEvent. Dropbox metadata
//   shapes (name, path, server_modified, .tag) fit easily inside the
//   R50.3a default contract (max_body_bytes=200).

import { enforceContract } from '../contract-enforcer';
import type { TranslatorInput, TranslatorResult, TranslatorError } from './types';
import { DEFAULT_MAX_EVENTS_PER_RUN } from './types';
import type { HarnessFlowEventInput } from '../../dal/types';

const DBX_API = 'https://api.dropboxapi.com/2';

interface DbxEntry {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  name: string;
  path_display?: string;
  server_modified?: string;
  client_modified?: string;
  size?: number;
}

interface DbxListResponse {
  entries: DbxEntry[];
  cursor: string;
  has_more: boolean;
}

async function dbx<T>(
  path: string,
  token: string,
  body: object,
): Promise<{ data: T } | { error: TranslatorError }> {
  const res = await fetch(`${DBX_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') || '';
    return { error: { code: 'dropbox_rate_limited', message: `Dropbox 429; Retry-After=${retryAfter}`, upstream: 'dropbox_429' } };
  }
  if (res.status === 401) {
    return { error: { code: 'dropbox_unauthorized', message: 'Dropbox token rejected', upstream: 'dropbox_401' } };
  }
  if (!res.ok) {
    return { error: { code: 'dropbox_api_error', message: `Dropbox ${res.status}: ${await res.text()}`, upstream: `dropbox_${res.status}` } };
  }
  return { data: (await res.json()) as T };
}

function eventIdForEntry(entry: DbxEntry): string {
  if (entry.id) return `usc_evt_dropbox_${entry.id.replace(/[^A-Za-z0-9_]/g, '_')}`;
  // .tag='deleted' entries have no id · hash the path instead (deterministic)
  const pathHash = (entry.path_display || entry.name).replace(/[^A-Za-z0-9_]/g, '_').slice(-40);
  return `usc_evt_dropbox_deleted_${pathHash}`;
}

function entryToEvent(entry: DbxEntry, providerUsername: string | null): HarnessFlowEventInput {
  const kindLabel = entry['.tag'] === 'folder' ? '📁' : entry['.tag'] === 'deleted' ? '🗑' : '📄';
  const occurred = entry.server_modified || entry.client_modified || new Date().toISOString();
  const pathBody = entry.path_display && entry.path_display !== entry.name
    ? `path:${entry.path_display.slice(0, 180)}`
    : null;
  return {
    id: eventIdForEntry(entry),
    source_tool: 'dropbox',
    agent_id: `dropbox:${providerUsername || 'unknown'}`,
    project_id: null,
    intent_id: null,
    status: entry['.tag'] === 'deleted' ? 'archived' : 'completed',
    summary: `${kindLabel} ${entry.name.slice(0, 180)}`,
    body: pathBody,
    evidence_link: entry.path_display ? `https://www.dropbox.com/home${encodeURI(entry.path_display)}` : null,
    visibility: 'internal_workspace',
    occurred_at: occurred,
  };
}

export async function runTranslator(input: TranslatorInput): Promise<TranslatorResult> {
  const { adapter, dal, userSource, since } = input;
  const maxEvents = input.max_events ?? DEFAULT_MAX_EVENTS_PER_RUN;
  const errors: TranslatorError[] = [];
  let events_emitted = 0;
  let events_rejected = 0;
  const workspaceId = userSource.workspace_id ?? '';

  let token: string;
  try {
    const snapshot = await adapter.getAccessToken(userSource.user_id, 'dropbox');
    token = snapshot.token;
  } catch (err) {
    return {
      events_emitted: 0,
      events_rejected: 0,
      errors: [{ code: (err as { code?: string }).code || 'OAUTH_CLERK_API_ERROR', message: (err as Error).message, upstream: 'clerk_adapter' }],
      completed_at: new Date().toISOString(),
    };
  }

  // Initial listing
  const initialResp = await dbx<DbxListResponse>('/files/list_folder', token, {
    path: '', // root
    recursive: true,
    limit: 100,
    include_deleted: false,
  });
  if ('error' in initialResp) {
    errors.push(initialResp.error);
    return { events_emitted, events_rejected, errors, completed_at: new Date().toISOString() };
  }
  // Wave λ-tail (postmortem cons #2): hold the narrowed data shape explicitly
  // so the while-loop body keeps the type guarantee across reassignment.
  // TS2339 errors at 141/163/165 stemmed from reassigning `resp` inside the
  // loop, which widened it back to the union and lost `.data` narrowing.
  let respData = initialResp.data;

  const providerUsername = userSource.provider_username; // captured from R50.3b connect-route
  const sinceMs = Date.parse(since);
  let pages = 0;
  const MAX_PAGES = 4;

  while (true) {
    for (const entry of respData.entries) {
      if (events_emitted >= maxEvents) break;
      // Filter by modification time (skip entries older than `since`)
      const occurredRaw = entry.server_modified || entry.client_modified;
      if (occurredRaw) {
        const occurredMs = Date.parse(occurredRaw);
        if (!Number.isNaN(occurredMs) && occurredMs < sinceMs) continue;
      } else if (entry['.tag'] !== 'deleted') {
        // No modification time on a non-deleted entry · skip rather than guess
        continue;
      }
      const event = entryToEvent(entry, providerUsername);
      const verdict = enforceContract(event, userSource.contract);
      if (!verdict.ok) { events_rejected++; continue; }
      try {
        await dal.upsertEvent(workspaceId, verdict.event);
        events_emitted++;
      } catch (err) {
        errors.push({ code: 'dal_upsert_failed', message: (err as Error).message });
      }
    }
    pages++;
    if (!respData.has_more || events_emitted >= maxEvents || pages >= MAX_PAGES) break;
    const nextResp = await dbx<DbxListResponse>('/files/list_folder/continue', token, {
      cursor: respData.cursor,
    });
    if ('error' in nextResp) {
      errors.push(nextResp.error);
      break;
    }
    respData = nextResp.data;
  }

  return {
    events_emitted,
    events_rejected,
    errors,
    completed_at: new Date().toISOString(),
  };
}
