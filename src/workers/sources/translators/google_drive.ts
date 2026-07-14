// translators/google_drive.ts · R50.3c · 2026-05-28
//
// Authority: R50 plan stage R50.3c · CLERK_OAUTH_PROVIDER_CONFIG.md
//
// Pulls Google Drive file + folder METADATA (never content) for files the
// user owns or has access to. Emits operation_events with source_tool='google_drive'.
//
// API SURFACE USED:
//   GET /drive/v3/files (Drive API v3) · with q=modifiedTime > '<since>'
//
// SCOPES REQUIRED (configured in Clerk dashboard):
//   https://www.googleapis.com/auth/drive.metadata.readonly
//   Strictly metadata · we never invoke any content-download endpoint.
//   The contract-enforcer's source_translator_ingests_file_content_beyond_contract
//   HARD stop is the architectural backstop; this comment is documentation only.
//
// RATE LIMIT:
//   Google enforces 429 with Retry-After. R50.3c stops the run on 429;
//   R50.3d will add per-translator backoff with the Retry-After value.
//
// CONTRACT INVARIANT:
//   Per-event enforceContract() before DAL.upsertEvent. Drive's metadata
//   shapes (name, mimeType, modifiedTime, parents) all fit within the
//   R50.3a default contract (max_body_bytes=200) without truncation in
//   the typical case.

import { enforceContract } from '../contract-enforcer';
import type { TranslatorInput, TranslatorResult, TranslatorError } from './types';
import { DEFAULT_MAX_EVENTS_PER_RUN } from './types';
import type { HarnessFlowEventInput } from '../../dal/types';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

interface DriveOwner {
  emailAddress?: string;
  displayName?: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  parents?: string[];
  owners?: DriveOwner[];
}

interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

async function drive<T>(
  path: string,
  token: string,
): Promise<{ data: T } | { error: TranslatorError }> {
  const res = await fetch(`${DRIVE_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') || '';
    return { error: { code: 'google_drive_rate_limited', message: `Drive 429; Retry-After=${retryAfter}`, upstream: 'google_429' } };
  }
  if (res.status === 401) {
    return { error: { code: 'google_drive_unauthorized', message: 'Google token rejected', upstream: 'google_401' } };
  }
  if (!res.ok) {
    return { error: { code: 'google_drive_api_error', message: `Drive ${res.status}: ${await res.text()}`, upstream: `google_${res.status}` } };
  }
  return { data: (await res.json()) as T };
}

function eventIdForFile(id: string): string {
  return `usc_evt_google_drive_${id}`;
}

function fileToEvent(f: DriveFile): HarnessFlowEventInput {
  const owner = f.owners?.[0];
  const ownerLabel = owner?.emailAddress || owner?.displayName || 'unknown';
  // Compact mime-type label · the full IANA strings are verbose
  const mimeShort = f.mimeType
    .replace(/^application\/vnd\.google-apps\./, 'gapp/')
    .replace(/^application\//, '')
    .replace(/^image\//, 'img/')
    .replace(/^text\//, 'txt/');
  // Parent folder ids · these aren't names but are deterministic; R50.3c
  // keeps it minimal (within max_body_bytes=200). A follow-up could resolve
  // to folder names via a second Drive API call but that doubles request cost.
  const body = f.parents && f.parents.length > 0
    ? `parents:${f.parents.join(',')}`
    : null;
  return {
    id: eventIdForFile(f.id),
    source_tool: 'google_drive',
    agent_id: `google_drive:${ownerLabel}`,
    project_id: null,
    intent_id: null,
    status: 'completed',
    summary: `[${mimeShort}] ${f.name.slice(0, 180)}`,
    body,
    evidence_link: `https://drive.google.com/file/d/${f.id}/view`,
    visibility: 'internal_workspace',
    occurred_at: f.modifiedTime,
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
    const snapshot = await adapter.getAccessToken(userSource.user_id, 'google_drive');
    token = snapshot.token;
  } catch (err) {
    return {
      events_emitted: 0,
      events_rejected: 0,
      errors: [{ code: (err as { code?: string }).code || 'OAUTH_CLERK_API_ERROR', message: (err as Error).message, upstream: 'clerk_adapter' }],
      completed_at: new Date().toISOString(),
    };
  }

  // Drive query: files modified after `since`, not in trash. Build the q
  // string carefully because Google's syntax requires single quotes around
  // datetime values (RFC3339).
  const q = encodeURIComponent(`modifiedTime > '${since}' and trashed = false`);
  const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,parents,owners(emailAddress,displayName))');

  let pageToken: string | undefined;
  let pages = 0;
  const MAX_PAGES = 4; // 4 pages × 50 = 200 candidates per run; max_events caps actual emissions

  do {
    const pathPart = `/files?pageSize=50&q=${q}&fields=${fields}&orderBy=modifiedTime desc${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const resp = await drive<DriveListResponse>(pathPart, token);
    if ('error' in resp) {
      errors.push(resp.error);
      break;
    }
    for (const f of resp.data.files || []) {
      if (events_emitted >= maxEvents) break;
      const event = fileToEvent(f);
      const verdict = enforceContract(event, userSource.contract);
      if (!verdict.ok) { events_rejected++; continue; }
      try {
        await dal.upsertEvent(workspaceId, verdict.event);
        events_emitted++;
      } catch (err) {
        errors.push({ code: 'dal_upsert_failed', message: (err as Error).message });
      }
    }
    pageToken = resp.data.nextPageToken;
    pages++;
  } while (pageToken && events_emitted < maxEvents && pages < MAX_PAGES);

  return {
    events_emitted,
    events_rejected,
    errors,
    completed_at: new Date().toISOString(),
  };
}
