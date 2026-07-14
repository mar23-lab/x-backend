// source-truth-override.test.ts · T1/P3 (260710) · the mechanical "connectedness beats the setup reminder".
// DECLARED AXES: event origin [system · provider · unknown] · event status [queued/pending/in_progress ·
// completed/archived · missing] · source state [connected+connected_at · connected w/o timestamp · errored ·
// absent] · text match [summary · body · multi-word provider · no mention].

import { describe, it, expect } from 'vitest';
import { demoteSupersededSetupEvents } from '../services/source-truth-override';

const EV = (over: Record<string, unknown>) => ({
  id: 'e1', source_tool: 'xlooop', status: 'queued', summary: 'Connect Gmail', body: null, ...over,
});
const GMAIL_CONNECTED = { provider: 'gmail', status: 'connected', connected_at: '2026-07-01T00:00:00Z' };

describe('demoteSupersededSetupEvents', () => {
  it('demotes a queued system "Connect Gmail" reminder once gmail IS connected (the felt-pain case)', () => {
    const r = demoteSupersededSetupEvents([EV({})], [GMAIL_CONNECTED]);
    expect(r.events).toEqual([]);
    expect(r.demoted.map((e) => e.id)).toEqual(['e1']);
    expect(r.audit).toEqual({ demoted_count: 1, superseding_providers: ['gmail'] });
  });

  it('KEEPS the reminder when the provider is NOT connected (errored / absent / missing connected_at)', () => {
    expect(demoteSupersededSetupEvents([EV({})], []).events.length).toBe(1);
    expect(demoteSupersededSetupEvents([EV({})], [{ provider: 'gmail', status: 'error', connected_at: '2026-07-01T00:00:00Z' }]).events.length).toBe(1);
    expect(demoteSupersededSetupEvents([EV({})], [{ provider: 'gmail', status: 'connected', connected_at: null }]).events.length).toBe(1);
  });

  it('never touches PROVIDER-origin events (a real gmail event is grounding truth, not a reminder)', () => {
    const real = EV({ id: 'e2', source_tool: 'gmail', summary: 'Email from client re: contract' });
    const r = demoteSupersededSetupEvents([real], [GMAIL_CONNECTED]);
    expect(r.events.map((e) => e.id)).toEqual(['e2']);
    expect(r.audit.demoted_count).toBe(0);
  });

  it('never touches TERMINAL setup rows (completed/archived = history, not advice) or status-less events', () => {
    const done = EV({ id: 'e3', status: 'completed' });
    const archived = EV({ id: 'e4', status: 'archived' });
    const statusless = EV({ id: 'e5', status: null });
    const r = demoteSupersededSetupEvents([done, archived, statusless], [GMAIL_CONNECTED]);
    expect(r.events.map((e) => e.id)).toEqual(['e3', 'e4', 'e5']);
  });

  it('keeps reminders that do not MENTION a connected provider; matches multi-word providers + body text', () => {
    const other = EV({ id: 'e6', summary: 'Review Q3 roadmap' });
    const driveBody = EV({ id: 'e7', summary: 'Setup task', body: 'Connect Google Drive for file metadata' });
    const r = demoteSupersededSetupEvents(
      [other, driveBody],
      [GMAIL_CONNECTED, { provider: 'google_drive', status: 'connected', connected_at: '2026-07-02T00:00:00Z' }],
    );
    expect(r.events.map((e) => e.id)).toEqual(['e6']); // roadmap stays; the drive reminder demotes ('google drive' variant)
    expect(r.audit.superseding_providers).toEqual(['google_drive']);
  });

  it('is order-preserving for kept events and pure (inputs untouched)', () => {
    const input = [EV({ id: 'a', summary: 'x' }), EV({ id: 'b' }), EV({ id: 'c', summary: 'y' })];
    const frozen = JSON.stringify(input);
    const r = demoteSupersededSetupEvents(input, [GMAIL_CONNECTED]);
    expect(r.events.map((e) => e.id)).toEqual(['a', 'c']);
    expect(JSON.stringify(input)).toBe(frozen);
  });
});
