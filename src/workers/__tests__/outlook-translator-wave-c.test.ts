// outlook-translator-wave-c.test.ts · Wave C · S5b (260628) — the second picker-provider translator.
// Same proof shape as the Gmail test: the mapping, the PRIVACY posture (preview-only body), never-throws,
// and the end-to-end run against a mocked Microsoft Graph + adapter + DAL.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runTranslator, messageToEvent } from '../sources/translators/outlook';
import { DEFAULT_R50_3A_CONTRACT } from '../sources/contract-enforcer';

afterEach(() => { vi.restoreAllMocks(); });

function res(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const sampleMsg = {
  id: 'AAMk1', subject: 'Q3 board pack',
  from: { emailAddress: { name: 'Jane Doe', address: 'jane@acme.example' } },
  receivedDateTime: '2024-06-27T09:30:00Z',
  bodyPreview: 'Attached the Q3 numbers ahead of Thursday',
  webLink: 'https://outlook.office365.com/owa/?ItemID=AAMk1',
};

describe('Wave C · S5b · outlook messageToEvent (mapping + privacy)', () => {
  it('maps subject/sender/preview/date/webLink into an operation_event', () => {
    const e = messageToEvent(sampleMsg);
    expect(e.source_tool).toBe('outlook');
    expect(e.summary).toBe('[Email] Q3 board pack');
    expect(e.agent_id).toBe('outlook:Jane Doe');
    expect(e.body).toBe('Attached the Q3 numbers ahead of Thursday');
    expect(e.occurred_at).toBe(new Date('2024-06-27T09:30:00Z').toISOString());
    expect(e.evidence_link).toBe('https://outlook.office365.com/owa/?ItemID=AAMk1');
    expect(e.status).toBe('completed');
  });

  it('PRIVACY: prefers the display name; falls back to the address only when no name', () => {
    expect(messageToEvent(sampleMsg).agent_id).toBe('outlook:Jane Doe');
    const noName = messageToEvent({ id: 'x', from: { emailAddress: { address: 'ops@acme.example' } } });
    expect(noName.agent_id).toBe('outlook:ops@acme.example');
  });

  it('tolerates missing subject/from/preview', () => {
    const e = messageToEvent({ id: 'x2' });
    expect(e.summary).toBe('[Email] (no subject)');
    expect(e.agent_id).toBe('outlook:unknown');
    expect(e.body).toBeNull();
    expect(e.evidence_link).toBeNull();
  });
});

describe('Wave C · S5b · outlook runTranslator (end-to-end against mocks)', () => {
  const adapter = { getAccessToken: vi.fn(async () => ({ provider: 'outlook', token: 'tok', external_account_id: 'ext', scopes: [], label: null, fetched_at: '2026-06-28T00:00:00Z' })) } as never;
  const userSource = { id: 'usc1', workspace_id: 'org_hy', user_id: 'user1', provider: 'outlook', contract: DEFAULT_R50_3A_CONTRACT, status: 'connected' } as never;

  it('lists once + emits one event per message via the DAL', async () => {
    globalThis.fetch = vi.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes('/messages?')) return Promise.resolve(res({ value: [sampleMsg, { ...sampleMsg, id: 'AAMk2', subject: 'Re: scheduling' }] }));
      return Promise.resolve(res('nope', 500));
    }) as never;
    const upsertEvent = vi.fn(async () => ({ inserted: true }));
    const dal = { upsertEvent } as never;
    const out = await runTranslator({ adapter, dal, userSource, since: '2026-06-01T00:00:00Z', max_events: 100 });
    expect(out.events_emitted).toBe(2);
    expect(out.errors).toEqual([]);
    expect(upsertEvent).toHaveBeenCalledTimes(2);
    expect((upsertEvent.mock.calls[0][1] as { source_tool: string }).source_tool).toBe('outlook');
    // one list call, no per-message fetch (Graph $select returns everything inline)
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it('NEVER throws — an OAuth token failure returns an error, not an exception', async () => {
    const failingAdapter = { getAccessToken: vi.fn(async () => { const e = new Error('not connected') as Error & { code: string }; e.code = 'OAUTH_NOT_CONNECTED'; throw e; }) } as never;
    const dal = { upsertEvent: vi.fn() } as never;
    const out = await runTranslator({ adapter: failingAdapter, dal, userSource, since: '2026-06-01T00:00:00Z' });
    expect(out.events_emitted).toBe(0);
    expect(out.errors[0].code).toBe('OAUTH_NOT_CONNECTED');
  });

  it('fails closed instead of writing Outlook events without a workspace target', async () => {
    const dal = { upsertEvent: vi.fn() } as never;
    const unbound = { ...userSource, workspace_id: null } as never;
    const out = await runTranslator({ adapter, dal, userSource: unbound, since: '2026-06-01T00:00:00Z' });
    expect(out.events_emitted).toBe(0);
    expect(out.errors[0].code).toBe('source_workspace_binding_required');
    expect((dal as any).upsertEvent).not.toHaveBeenCalled();
  });
});
