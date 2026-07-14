// source-truth-override.ts · T1/P3 (260710) · the MECHANICAL half of "source truth beats stale setup rows".
//
// THE FELT PAIN: a system setup reminder ("Connect Gmail", source_tool 'xlooop', status 'queued') keeps
// grounding chat answers AFTER the customer has actually connected Gmail — the model reads the stale row and
// tells a connected customer to connect. Until now the only counter was a soft prompt line ("Connected source
// truth (authoritative over setup-reminder events)") — prose the model may or may not honor. This module makes
// the override MECHANICAL: a superseded setup reminder is demoted OUT of the grounding set before the prompt
// is assembled.
//
// DEMOTION RULE (deliberately narrow — grounded in the real event shape, not guessed semantics):
//   demote an event iff ALL of:
//     1. SYSTEM origin — source_tool ∈ {'xlooop','mbp','operator','harness'} (never a provider's own events);
//     2. NON-TERMINAL status — 'queued' | 'pending' | 'in_progress' (a completed/archived setup row is
//        history, not advice — it stays);
//     3. its summary/body mentions a provider that IS CONNECTED (source fact status 'connected' with a
//        connected_at) — connectedness is the superseding truth; an unconnected provider's reminder stands.
// Anything not matching all three grounds exactly as before.
//
// PURE + flag-gated at the route (CHAT_SOURCE_TRUTH_OVERRIDE_ENABLED, default OFF ⇒ byte-identical).
// cockpit-chat.ts is WARN-band and must not grow — this lives beside chat-graph-context.ts by the same rule.

export interface OverridableEvent {
  id?: string;
  source_tool?: string | null;
  status?: string | null;
  summary?: string | null;
  body?: string | null;
}

export interface ConnectedSourceView {
  provider: string;
  status: string;
  connected_at?: string | null;
}

export interface SourceTruthOverrideResult<E> {
  events: E[];
  demoted: E[];
  /** machine-readable audit line fragment: which providers superseded how many reminders. */
  audit: { demoted_count: number; superseding_providers: string[] };
}

const SYSTEM_ORIGINS = new Set(['xlooop', 'mbp', 'operator', 'harness']);
const NON_TERMINAL = new Set(['queued', 'pending', 'in_progress']);

/** provider token variants a reminder text may use ('google_drive' → 'google drive' too). */
function providerTokens(provider: string): string[] {
  const p = provider.toLowerCase();
  return p.includes('_') ? [p, p.replace(/_/g, ' ')] : [p];
}

function mentionsProvider(text: string, provider: string): boolean {
  const hay = text.toLowerCase();
  return providerTokens(provider).some((t) => hay.includes(t));
}

/**
 * Demote system setup reminders superseded by a CONNECTED source. Pure; order-preserving for kept events.
 */
export function demoteSupersededSetupEvents<E extends OverridableEvent>(
  events: readonly E[],
  sources: readonly ConnectedSourceView[],
): SourceTruthOverrideResult<E> {
  const connected = sources.filter((s) => s && String(s.status) === 'connected' && !!s.connected_at && !!s.provider);
  if (!connected.length || !events.length) {
    return { events: [...events], demoted: [], audit: { demoted_count: 0, superseding_providers: [] } };
  }
  const kept: E[] = [];
  const demoted: E[] = [];
  const superseding = new Set<string>();
  for (const e of events) {
    const origin = String(e?.source_tool || '').toLowerCase();
    const status = String(e?.status || '').toLowerCase();
    const text = `${e?.summary || ''} ${e?.body || ''}`;
    const supersededBy = SYSTEM_ORIGINS.has(origin) && NON_TERMINAL.has(status)
      ? connected.find((s) => mentionsProvider(text, s.provider))
      : undefined;
    if (supersededBy) { demoted.push(e); superseding.add(supersededBy.provider); }
    else kept.push(e);
  }
  return { events: kept, demoted, audit: { demoted_count: demoted.length, superseding_providers: [...superseding].sort() } };
}
