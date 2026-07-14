// gmail-translator-wave-c.test.ts · Wave C · S5b (260628) — the first picker-provider translator.
// Proves the mapping (Gmail metadata → operation_event), the PRIVACY posture (sender address
// stripped, snippet-only body, never the full message), the never-throws contract, and the
// end-to-end run against mocked Gmail API + adapter + DAL.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runTranslator, messageToEvent } from '../sources/translators/gmail';
import { DEFAULT_R50_3A_CONTRACT } from '../sources/contract-enforcer';

afterEach(() => { vi.restoreAllMocks(); });

function res(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const sampleMsg = {
  id: 'm1', internalDate: '1719446400000', // 2024-06-27 (epoch ms)
  snippet: 'June invoice attached, due net-30',
  payload: { headers: [
    { name: 'From', value: 'Jane Doe <jane@acme.example>' },
    { name: 'Subject', value: 'June invoice' },
    { name: 'Date', value: 'Thu, 27 Jun 2024 00:00:00 +0000' },
  ] },
};

describe('Wave C · S5b · messageToEvent (mapping + privacy)', () => {
  it('maps subject/sender/snippet/date into an operation_event', () => {
    const e = messageToEvent(sampleMsg);
    expect(e.source_tool).toBe('gmail');
    expect(e.summary).toBe('[Email] June invoice');
    expect(e.status).toBe('completed');
    expect(e.body).toBe('June invoice attached, due net-30');
    expect(e.occurred_at).toBe(new Date(1719446400000).toISOString());
    expect(e.visibility).toBe('internal_workspace');
    expect(e.id).toBe('usc_evt_gmail_msg_m1');
  });

  it('PRIVACY: the sender email address is stripped from agent_id (display name only)', () => {
    const e = messageToEvent(sampleMsg);
    expect(e.agent_id).toBe('gmail:Jane Doe');
    expect(e.agent_id).not.toContain('@'); // raw address never lands in the event
  });

  it('tolerates missing headers/snippet', () => {
    const e = messageToEvent({ id: 'm2', payload: { headers: [] } });
    expect(e.summary).toBe('[Email] (no subject)');
    expect(e.agent_id).toBe('gmail:unknown');
    expect(e.body).toBeNull(); // no snippet → no body, never a fabricated one
  });
});

describe('Wave C · S5b · runTranslator (end-to-end against mocks)', () => {
  const adapter = { getAccessToken: vi.fn(async () => ({ provider: 'gmail', token: 'tok', external_account_id: 'ext', scopes: [], label: null, fetched_at: '2026-06-28T00:00:00Z' })) } as never;
  const userSource = { id: 'usc1', workspace_id: 'org_hy', user_id: 'user1', provider: 'gmail', contract: DEFAULT_R50_3A_CONTRACT, status: 'connected' } as never;

  it('lists + fetches + emits one event per message via the DAL', async () => {
    globalThis.fetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes('/messages?')) return Promise.resolve(res({ messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }] }));
      if (u.includes('/messages/m1')) return Promise.resolve(res(sampleMsg));
      if (u.includes('/messages/m2')) return Promise.resolve(res({ ...sampleMsg, id: 'm2', snippet: 'Re: scheduling' }));
      return Promise.resolve(res('nope', 500));
    }) as never;
    const upsertEvent = vi.fn(async () => ({ inserted: true }));
    const dal = { upsertEvent } as never;
    const out = await runTranslator({ adapter, dal, userSource, since: '2026-06-01T00:00:00Z', max_events: 100 });
    expect(out.events_emitted).toBe(2);
    expect(out.errors).toEqual([]);
    expect(upsertEvent).toHaveBeenCalledTimes(2);
    expect((upsertEvent.mock.calls[0][1] as { source_tool: string }).source_tool).toBe('gmail');
  });

  it('NEVER throws — an OAuth token failure returns an error, not an exception', async () => {
    const failingAdapter = { getAccessToken: vi.fn(async () => { const e = new Error('not connected') as Error & { code: string }; e.code = 'OAUTH_NOT_CONNECTED'; throw e; }) } as never;
    const dal = { upsertEvent: vi.fn() } as never;
    const out = await runTranslator({ adapter: failingAdapter, dal, userSource, since: '2026-06-01T00:00:00Z' });
    expect(out.events_emitted).toBe(0);
    expect(out.errors[0].code).toBe('OAUTH_NOT_CONNECTED');
  });

  it('fails closed instead of writing Gmail events without a workspace target', async () => {
    const dal = { upsertEvent: vi.fn() } as never;
    const unbound = { ...userSource, workspace_id: null } as never;
    const out = await runTranslator({ adapter, dal, userSource: unbound, since: '2026-06-01T00:00:00Z' });
    expect(out.events_emitted).toBe(0);
    expect(out.errors[0].code).toBe('source_workspace_binding_required');
    expect((dal as any).upsertEvent).not.toHaveBeenCalled();
  });
});
