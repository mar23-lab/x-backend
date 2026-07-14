// translators/outlook.ts · Wave C · S5b (260628) — second picker-provider translator.
//
// Authority: the R50.3c translator framework (mirrors translators/gmail.ts) + Part Q S5b.
//
// Pulls the user's RECENT Outlook / Microsoft 365 mail (METADATA ONLY — subject / sender /
// receivedDateTime / Graph's short bodyPreview; NEVER the full body) and emits operation_events
// with source_tool='outlook', so the operator's real email reality reaches the workspace + the AI.
//
// Reuses the Clerk `microsoft` provider (the same one microsoft_onedrive uses) — the operator adds
// the Mail.Read scope in the Clerk dashboard. Microsoft Graph returns all fields in ONE list call
// (via $select), so unlike Gmail there is no per-message fetch.
//
// API SURFACE USED:
//   GET /v1.0/me/messages?$top=N&$select=id,subject,from,receivedDateTime,bodyPreview,webLink
//       &$orderby=receivedDateTime desc&$filter=receivedDateTime ge <since>
//
// SCOPES REQUIRED (operator configures on the Clerk Microsoft provider):
//   Mail.Read
//
// RATE LIMIT: Graph throttles with 429 + Retry-After; we stop on 429. CONTRACT: enforceContract() per event.

import { enforceContract } from '../contract-enforcer';
import type { TranslatorInput, TranslatorResult, TranslatorError } from './types';
import { DEFAULT_MAX_EVENTS_PER_RUN } from './types';
import type { HarnessFlowEventInput } from '../../dal/types';

const GRAPH_API = 'https://graph.microsoft.com/v1.0/me';

export interface GraphMessage {
  id: string;
  subject?: string | null;
  from?: { emailAddress?: { name?: string; address?: string } } | null;
  receivedDateTime?: string;
  bodyPreview?: string;
  webLink?: string;
}
interface GraphListResp { value?: GraphMessage[]; }

async function gr<T>(path: string, token: string): Promise<{ data: T } | { error: TranslatorError }> {
  const res = await fetch(`${GRAPH_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'xlooop-s5b-translator' },
  });
  if (res.status === 429) return { error: { code: 'outlook_rate_limited', message: 'Graph 429', upstream: 'graph_429' } };
  if (res.status === 401) return { error: { code: 'outlook_unauthorized', message: 'Graph token rejected', upstream: 'graph_401' } };
  if (res.status === 403) return { error: { code: 'outlook_forbidden', message: 'Graph 403 — Mail.Read scope not granted in Clerk?', upstream: 'graph_403' } };
  if (!res.ok) return { error: { code: 'outlook_api_error', message: `Graph ${res.status}`, upstream: `graph_${res.status}` } };
  return { data: (await res.json()) as T };
}

/** PURE: Graph message metadata → an operation_event. Exported for unit testing the mapping. */
export function messageToEvent(msg: GraphMessage): HarnessFlowEventInput {
  const subject = msg.subject && msg.subject.trim() ? msg.subject : '(no subject)';
  // Sender label: prefer the display name; fall back to the address. (Their own mailbox, their workspace.)
  const sender = msg.from?.emailAddress?.name?.trim() || msg.from?.emailAddress?.address?.trim() || 'unknown';
  const occurredAt = msg.receivedDateTime ? new Date(msg.receivedDateTime).toISOString() : new Date().toISOString();
  return {
    id: `usc_evt_outlook_msg_${msg.id}`,
    source_tool: 'outlook',
    agent_id: `outlook:${sender}`,
    project_id: null,
    intent_id: null,
    status: 'completed', // an email is a completed communication event
    summary: `[Email] ${subject.slice(0, 180)}`,
    body: msg.bodyPreview && msg.bodyPreview.trim() ? msg.bodyPreview.trim() : null,
    evidence_link: msg.webLink || null,
    visibility: 'internal_workspace',
    occurred_at: occurredAt,
  };
}

export async function runTranslator(input: TranslatorInput): Promise<TranslatorResult> {
  const { adapter, dal, userSource, since } = input;
  const maxEvents = input.max_events ?? DEFAULT_MAX_EVENTS_PER_RUN;
  const errors: TranslatorError[] = [];
  let events_emitted = 0;
  let events_rejected = 0;
  const workspaceId = String(userSource.workspace_id || '').trim();
  if (!workspaceId) {
    return {
      events_emitted: 0,
      events_rejected: 0,
      errors: [{
        code: 'source_workspace_binding_required',
        message: 'Outlook translator refused to write events without a workspace target.',
        upstream: 'xlooop_source_binding',
      }],
      completed_at: new Date().toISOString(),
    };
  }

  let token: string;
  try {
    const snapshot = await adapter.getAccessToken(userSource.user_id, 'outlook');
    token = snapshot.token;
  } catch (err) {
    return {
      events_emitted: 0, events_rejected: 0,
      errors: [{ code: (err as { code?: string }).code || 'OAUTH_CLERK_API_ERROR', message: (err as Error).message, upstream: 'clerk_adapter' }],
      completed_at: new Date().toISOString(),
    };
  }

  const top = Math.min(maxEvents, 50);
  const query = `/messages?$top=${top}`
    + `&$select=${encodeURIComponent('id,subject,from,receivedDateTime,bodyPreview,webLink')}`
    + `&$orderby=${encodeURIComponent('receivedDateTime desc')}`
    + `&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
  const listResp = await gr<GraphListResp>(query, token);
  if ('error' in listResp) {
    errors.push(listResp.error);
    return { events_emitted, events_rejected, errors, completed_at: new Date().toISOString() };
  }

  for (const msg of listResp.data.value || []) {
    if (events_emitted >= maxEvents) break;
    const event = messageToEvent(msg);
    const verdict = enforceContract(event, userSource.contract);
    if (!verdict.ok) { events_rejected++; continue; }
    try { await dal.upsertEvent(workspaceId, verdict.event); events_emitted++; }
    catch (err) { errors.push({ code: 'dal_upsert_failed', message: (err as Error).message }); }
  }

  return { events_emitted, events_rejected, errors, completed_at: new Date().toISOString() };
}
