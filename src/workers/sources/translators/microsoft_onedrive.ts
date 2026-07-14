// translators/microsoft_onedrive.ts · R50.3c · 2026-05-28
//
// Authority: R50 plan stage R50.3c · CLERK_OAUTH_PROVIDER_CONFIG.md
//
// Pulls OneDrive file + folder METADATA via Microsoft Graph API v1.0.
// Emits operation_events with source_tool='microsoft_onedrive'.
//
// API SURFACE USED:
//   GET /me/drive/recent     · recently used drive items (sorted by recency)
//
// We deliberately do NOT use /me/drive/root/delta in R50.3c because delta
// requires durable cursor storage per-source (R50.3d responsibility).
// /recent gives us "what changed recently" via natural ordering and we
// client-side filter on lastModifiedDateTime ≥ `since`.
//
// SCOPES REQUIRED (configured in Clerk dashboard):
//   Files.Read.All · User.Read
//
// RATE LIMIT:
//   MS Graph returns 429 with Retry-After. R50.3c stops on 429; R50.3d
//   adds backoff.
//
// CONTRACT INVARIANT:
//   Per-event enforceContract() before DAL.upsertEvent.

import { enforceContract } from '../contract-enforcer';
import type { TranslatorInput, TranslatorResult, TranslatorError } from './types';
import { DEFAULT_MAX_EVENTS_PER_RUN } from './types';
import type { HarnessFlowEventInput } from '../../dal/types';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

interface DriveItemUser {
  email?: string;
  displayName?: string;
}

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  createdBy?: { user?: DriveItemUser };
  lastModifiedBy?: { user?: DriveItemUser };
  parentReference?: { path?: string; name?: string };
}

interface RecentResponse {
  value: DriveItem[];
  '@odata.nextLink'?: string;
}

async function graph<T>(
  url: string,
  token: string,
): Promise<{ data: T } | { error: TranslatorError }> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') || '';
    return { error: { code: 'onedrive_rate_limited', message: `MS Graph 429; Retry-After=${retryAfter}`, upstream: 'graph_429' } };
  }
  if (res.status === 401) {
    return { error: { code: 'onedrive_unauthorized', message: 'MS Graph token rejected', upstream: 'graph_401' } };
  }
  if (!res.ok) {
    return { error: { code: 'onedrive_api_error', message: `MS Graph ${res.status}: ${await res.text()}`, upstream: `graph_${res.status}` } };
  }
  return { data: (await res.json()) as T };
}

function eventIdForItem(id: string): string {
  // Drive item IDs from MS Graph contain alphanumerics + sometimes !. Strip ! for safe ids.
  return `usc_evt_microsoft_onedrive_${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

function itemToEvent(it: DriveItem): HarnessFlowEventInput {
  const kindLabel = it.folder ? '📁' : '📄';
  const ownerLabel = it.lastModifiedBy?.user?.email || it.lastModifiedBy?.user?.displayName
                  || it.createdBy?.user?.email || it.createdBy?.user?.displayName
                  || 'unknown';
  // Compact mime label
  const mimeShort = it.file?.mimeType
    ? it.file.mimeType.replace(/^application\//, '').replace(/^image\//, 'img/').replace(/^text\//, 'txt/')
    : (it.folder ? 'folder' : 'item');
  const parentPath = it.parentReference?.path ? it.parentReference.path.replace(/^\/drive\/root:/, '') : '';
  const body = parentPath ? `parent:${parentPath.slice(0, 180)}` : null;
  return {
    id: eventIdForItem(it.id),
    source_tool: 'microsoft_onedrive',
    agent_id: `microsoft_onedrive:${ownerLabel}`,
    project_id: null,
    intent_id: null,
    status: 'completed',
    summary: `${kindLabel} [${mimeShort}] ${it.name.slice(0, 180)}`,
    body,
    evidence_link: it.webUrl || null,
    visibility: 'internal_workspace',
    occurred_at: it.lastModifiedDateTime || new Date().toISOString(),
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
    const snapshot = await adapter.getAccessToken(userSource.user_id, 'microsoft_onedrive');
    token = snapshot.token;
  } catch (err) {
    return {
      events_emitted: 0,
      events_rejected: 0,
      errors: [{ code: (err as { code?: string }).code || 'OAUTH_CLERK_API_ERROR', message: (err as Error).message, upstream: 'clerk_adapter' }],
      completed_at: new Date().toISOString(),
    };
  }

  const sinceMs = Date.parse(since);
  let nextUrl: string | undefined = `${GRAPH_API}/me/drive/recent?$top=50`;
  let pages = 0;
  const MAX_PAGES = 4;

  while (nextUrl && events_emitted < maxEvents && pages < MAX_PAGES) {
    // Wave λ-tail (postmortem cons #2): explicit annotation breaks the
    // "implicit any from self-reference" cycle TS7022 reported (function
    // generic inference saw `resp` shadowing within the loop scope).
    const resp: { data: RecentResponse } | { error: TranslatorError } = await graph<RecentResponse>(nextUrl, token);
    if ('error' in resp) {
      errors.push(resp.error);
      break;
    }
    for (const it of resp.data.value || []) {
      if (events_emitted >= maxEvents) break;
      // Client-side filter on lastModifiedDateTime ≥ since
      if (it.lastModifiedDateTime) {
        const itMs = Date.parse(it.lastModifiedDateTime);
        if (!Number.isNaN(itMs) && itMs < sinceMs) continue;
      }
      const event = itemToEvent(it);
      const verdict = enforceContract(event, userSource.contract);
      if (!verdict.ok) { events_rejected++; continue; }
      try {
        await dal.upsertEvent(workspaceId, verdict.event);
        events_emitted++;
      } catch (err) {
        errors.push({ code: 'dal_upsert_failed', message: (err as Error).message });
      }
    }
    nextUrl = resp.data['@odata.nextLink'];
    pages++;
  }

  return {
    events_emitted,
    events_rejected,
    errors,
    completed_at: new Date().toISOString(),
  };
}
