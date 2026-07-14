// translators/gmail.ts · Wave C · S5b (260628) — the FIRST picker-provider translator.
//
// Authority: the R50.3c translator framework (mirrors translators/gitlab.ts) + Part Q S5b.
//
// Pulls the user's RECENT Gmail messages (METADATA ONLY — From / Subject / Date / Gmail's
// short snippet; NEVER the full body) and emits operation_events with source_tool='gmail',
// so the operator's real email reality reaches the workspace + the AI company-context.
//
// Privacy posture: subject + sender + the short snippet only; visibility 'internal_workspace';
// per-event enforceContract() bounds the body. Read-only (gmail.readonly scope). The user
// connected their OWN mailbox to their OWN workspace.
//
// API SURFACE USED:
//   GET /gmail/v1/users/me/messages?q=after:<epoch>&maxResults=N        · list message ids
//   GET /gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=From,Subject,Date
//
// SCOPES REQUIRED (operator configures on the Clerk Google provider — same provider as google_drive):
//   https://www.googleapis.com/auth/gmail.readonly
//
// RATE LIMIT: Gmail per-user quota; 429 → stop. CONTRACT INVARIANT: enforceContract() per event.

import { enforceContract } from '../contract-enforcer';
import type { TranslatorInput, TranslatorResult, TranslatorError } from './types';
import { DEFAULT_MAX_EVENTS_PER_RUN } from './types';
import type { HarnessFlowEventInput } from '../../dal/types';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailListResp { messages?: Array<{ id: string; threadId: string }>; }
interface GmailHeader { name: string; value: string; }
export interface GmailMessage {
  id: string;
  internalDate?: string; // epoch ms as string
  snippet?: string;
  payload?: { headers?: GmailHeader[] };
}

async function gm<T>(path: string, token: string): Promise<{ data: T } | { error: TranslatorError }> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'xlooop-s5b-translator' },
  });
  if (res.status === 429) return { error: { code: 'gmail_rate_limited', message: 'Gmail 429', upstream: 'gmail_429' } };
  if (res.status === 401) return { error: { code: 'gmail_unauthorized', message: 'Gmail token rejected', upstream: 'gmail_401' } };
  if (res.status === 403) return { error: { code: 'gmail_forbidden', message: 'Gmail 403 — gmail.readonly scope not granted in Clerk?', upstream: 'gmail_403' } };
  if (!res.ok) return { error: { code: 'gmail_api_error', message: `Gmail ${res.status}`, upstream: `gmail_${res.status}` } };
  return { data: (await res.json()) as T };
}

function header(msg: GmailMessage, name: string): string | null {
  const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

/** PURE: Gmail message metadata → an operation_event. Exported for unit testing the mapping. */
export function messageToEvent(msg: GmailMessage): HarnessFlowEventInput {
  const from = header(msg, 'From') || 'unknown';
  const subject = header(msg, 'Subject') || '(no subject)';
  const dateHeader = header(msg, 'Date');
  const occurredAt = msg.internalDate
    ? new Date(parseInt(msg.internalDate, 10)).toISOString()
    : (dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString());
  // Sender label: strip the angle-bracket address to the display name (privacy-leaner handle).
  const sender = from.replace(/\s*<[^>]*>\s*/, '').trim() || from;
  return {
    id: `usc_evt_gmail_msg_${msg.id}`,
    source_tool: 'gmail',
    agent_id: `gmail:${sender}`,
    project_id: null,
    intent_id: null,
    status: 'completed', // an email is a completed communication event
    summary: `[Email] ${subject.slice(0, 180)}`,
    body: msg.snippet && msg.snippet.trim() ? msg.snippet.trim() : null,
    evidence_link: `https://mail.google.com/mail/u/0/#all/${msg.id}`,
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
        message: 'Gmail translator refused to write events without a workspace target.',
        upstream: 'xlooop_source_binding',
      }],
      completed_at: new Date().toISOString(),
    };
  }

  let token: string;
  try {
    const snapshot = await adapter.getAccessToken(userSource.user_id, 'gmail');
    token = snapshot.token;
  } catch (err) {
    return {
      events_emitted: 0, events_rejected: 0,
      errors: [{ code: (err as { code?: string }).code || 'OAUTH_CLERK_API_ERROR', message: (err as Error).message, upstream: 'clerk_adapter' }],
      completed_at: new Date().toISOString(),
    };
  }

  const afterEpoch = Math.floor(Date.parse(since) / 1000) || 0;
  const listResp = await gm<GmailListResp>(
    `/messages?q=${encodeURIComponent(`after:${afterEpoch}`)}&maxResults=${Math.min(maxEvents, 50)}`,
    token,
  );
  if ('error' in listResp) {
    errors.push(listResp.error);
    return { events_emitted, events_rejected, errors, completed_at: new Date().toISOString() };
  }
  const ids = (listResp.data.messages || []).map((m) => m.id);

  for (const id of ids) {
    if (events_emitted >= maxEvents) break;
    const msgResp = await gm<GmailMessage>(
      `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      token,
    );
    if ('error' in msgResp) {
      errors.push(msgResp.error);
      if (msgResp.error.upstream === 'gmail_429' || msgResp.error.upstream === 'gmail_401') break;
      continue;
    }
    const event = messageToEvent(msgResp.data);
    const verdict = enforceContract(event, userSource.contract);
    if (!verdict.ok) { events_rejected++; continue; }
    try { await dal.upsertEvent(workspaceId, verdict.event); events_emitted++; }
    catch (err) { errors.push({ code: 'dal_upsert_failed', message: (err as Error).message }); }
  }

  return { events_emitted, events_rejected, errors, completed_at: new Date().toISOString() };
}
