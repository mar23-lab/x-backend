// cockpit-chat.test.ts · 2026-06-09
// Unit tests for the GROUNDED cockpit chat ("Chat-that-acts v1"). Asserts the answer references the
// REAL event data (counts, statuses, named recent items) and the never-throws / never-invents
// LLM-with-deterministic-fallback contract. Events are mocked with the real HarnessFlowEvent shape.

import { describe, it, expect, afterEach } from 'vitest';
import {
  answerCockpitChat,
  compileChatFacts,
  buildDeterministicChatAnswer,
  classifyGovernanceRow,
  governanceRowInScope,
  mapGovernanceRowsToEvents,
  mapContextCardsToEvents,
  type CockpitChatFacts,
  type CockpitChatScope,
  type GovernanceStreamRow,
} from '../services/cockpit-chat';
import type { AiRunner } from '../services/agent-digest';
import type { HarnessFlowEvent } from '../dal/types/event';

// Real-shaped events modeled on the prod Cockpit project (GitHub PR/commit activity).
function evt(over: Partial<HarnessFlowEvent>): HarnessFlowEvent {
  return {
    id: 'evt1', workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux',
    source_tool: 'github', agent_id: null, intent_id: null, status: 'completed',
    summary: 'an event', body: null, evidence_link: null, visibility: 'internal_workspace',
    permission_scope: null, risk: null, approval_state: null, next_action: null,
    occurred_at: new Date().toISOString(), domain_id: null, ...over,
  } as HarnessFlowEvent;
}

const COCKPIT_EVENTS: HarnessFlowEvent[] = [
  evt({ id: 'e1', summary: 'fix(cockpit): legible empty/degraded project banner + chat event-threading (#515)', status: 'completed', occurred_at: '2026-06-09T03:13:34.000Z' }),
  evt({ id: 'e2', summary: 'feat(cockpit): operator overlay on GET /projects/:id/events (#516)', status: 'completed', occurred_at: '2026-06-09T03:13:27.000Z' }),
  evt({ id: 'e3', summary: 'PR: feat(cockpit): operator overlay on /projects/:id/events', status: 'running', occurred_at: '2026-06-09T02:43:02.000Z' }),
  evt({ id: 'e4', summary: 'feat(metrics): operator DAU / return-rate engagement readout', status: 'completed', occurred_at: '2026-06-09T00:33:14.000Z' }),
  evt({ id: 'e5', summary: 'Owner confirmation needed · OperationsLiveStream v1', status: 'needs_review', approval_state: 'pending', occurred_at: '2026-06-08T20:00:00.000Z' }),
  evt({ id: 'e6', summary: 'Sign-off blocked · gate missing', status: 'blocked', occurred_at: '2026-06-08T18:00:00.000Z' }),
];

const FACTS = (over: Partial<CockpitChatFacts> = {}): CockpitChatFacts => ({
  events: COCKPIT_EVENTS,
  total: 269, // the true scope size (prod Cockpit project) even though we only pass a recent page
  scope: { workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux', domain_id: null },
  ...over,
});

describe('compileChatFacts — grounding extraction', () => {
  it('extracts real counts, statuses, top sources, and named recent items', () => {
    const g = compileChatFacts(FACTS());
    expect(g.events_total).toBe(269);
    expect(g.events_considered).toBe(6);
    expect(g.completed).toBe(3); // e1, e2, e4
    expect(g.in_progress).toBe(1); // e3 running
    expect(g.needs_review).toBe(1); // e5
    expect(g.blocked).toBe(1); // e6
    expect(g.top_sources[0]).toEqual({ source: 'github', count: 6 });
    expect(g.recent[0].summary).toMatch(/legible empty\/degraded project banner/);
    expect(g.recent[0].status).toBe('completed');
  });
});

describe('compileChatFacts — data_freshness (P0.1: never imply "all clear" over stale data)', () => {
  it('flags a stale record and reports the newest-event age', () => {
    const g = compileChatFacts(FACTS()); // COCKPIT_EVENTS are dated 2026-06-09 → stale vs now
    expect(g.data_freshness.is_stale).toBe(true);
    expect(g.data_freshness.staleness_minutes).toBeGreaterThan(60);
    expect(g.data_freshness.newest_event_at).toContain('2026-06-09');
  });
  it('does NOT flag a fresh record (newest event within the 60-min window)', () => {
    const g = compileChatFacts(FACTS({ events: [evt({ id: 'fresh', occurred_at: new Date().toISOString() })] }));
    expect(g.data_freshness.is_stale).toBe(false);
    expect(g.data_freshness.staleness_minutes).toBeLessThanOrEqual(1);
  });
});

describe('compileChatFacts — agents resolution (P0.4: name which governed agent acted)', () => {
  it('resolves a registered agent_id to its role + skills', () => {
    const g = compileChatFacts(FACTS({ events: [evt({ id: 'a1', agent_id: 'xlooop:digest-agent' })] }));
    const a = g.agents.find((x) => x.agent_id === 'xlooop:digest-agent');
    expect(a).toBeTruthy();
    expect(a!.role).toBe('drafter');
    expect(a!.skills).toContain('workspace-digest');
  });
  it('flags an unregistered agent_id (drift signal) and ignores human/operator activity', () => {
    const g = compileChatFacts(FACTS({ events: [
      evt({ id: 'a2', agent_id: 'xlooop:ghost-agent' }),
      evt({ id: 'a3', agent_id: null }),
    ] }));
    expect(g.agents.find((x) => x.agent_id === 'xlooop:ghost-agent')?.role).toBe('unregistered');
    expect(g.agents.some((x) => !x.agent_id)).toBe(false);
  });
});

describe('buildDeterministicChatAnswer — grounded, not canned', () => {
  it('references the REAL total + status posture + a named recent item', () => {
    const g = compileChatFacts(FACTS());
    const a = buildDeterministicChatAnswer('summarize what is happening here', g, FACTS().scope);
    expect(a).toMatch(/269 events on record/);
    expect(a).toMatch(/3 completed/);
    expect(a).toMatch(/1 awaiting your sign-off/);
    expect(a).toMatch(/github \(6\)/);
    expect(a).toMatch(/legible empty\/degraded project banner/); // a real named item
  });

  it('surfaces blocked / sign-off items first when the operator asks for them', () => {
    const g = compileChatFacts(FACTS());
    const a = buildDeterministicChatAnswer("what's blocked or needs my sign-off?", g, FACTS().scope);
    expect(a).toMatch(/1 item need your sign-off/);
    expect(a).toMatch(/1 item blocked/);
  });

  it('is honest when the scope is empty (no fabricated activity)', () => {
    const a = buildDeterministicChatAnswer('summarize', compileChatFacts({ events: [], total: 0, scope: FACTS().scope }), FACTS().scope);
    expect(a).toMatch(/no recorded activity in this project yet/);
    expect(a).not.toMatch(/269/);
  });
});

describe('answerCockpitChat — LLM-richer + fail-safe + grounded provenance', () => {
  it('falls back to the deterministic grounded answer when there is NO AI binding', async () => {
    const r = await answerCockpitChat('summarize what is happening here', FACTS());
    expect(r.generated_by).toBe('deterministic');
    expect(r.answer).toMatch(/269 events on record/);
    expect(r.grounded_on.events_total).toBe(269);
    expect(r.grounded_on.recent[0].summary).toMatch(/legible empty\/degraded project banner/);
  });

  it('uses the LLM answer when the binding returns usable text, with grounded provenance attached', async () => {
    const ai: AiRunner = {
      run: async () => ({ response: 'Across this project the team has shipped cockpit clarity work: 269 events on record, with recent PRs on the project banner and the operator overlay. One item awaits your sign-off and one is blocked on a missing gate.' }),
    };
    const r = await answerCockpitChat('summarize what is happening here', FACTS(), ai);
    expect(r.generated_by).toBe('llm');
    expect(r.answer).toMatch(/269 events/);
    // provenance still computed from the real events regardless of who wrote the prose
    expect(r.grounded_on.completed).toBe(3);
    expect(r.grounded_on.blocked).toBe(1);
  });

  it('feeds the model ONLY the real facts + instructs no-invention (no fabricated numbers possible)', async () => {
    let system = '';
    let user = '';
    const ai: AiRunner = {
      run: async (_m, opts) => { system = opts.messages[0].content; user = opts.messages[1].content; return { response: 'A grounded answer that is definitely long enough to pass the length floor for usable LLM output.' }; },
    };
    await answerCockpitChat('what changed recently?', FACTS(), ai);
    expect(system).toMatch(/ONLY the event facts/i);
    expect(system).toMatch(/never invent/i);
    expect(user).toMatch(/Total items on record: 269 \(6 activity events \+ 0 governance/);
    expect(user).toMatch(/legible empty\/degraded project banner/); // the real recent item is in the prompt
    expect(user).toMatch(/what changed recently\?/); // the operator question is threaded
  });

  it('falls back to deterministic when the AI binding THROWS (never 5xx)', async () => {
    const ai: AiRunner = { run: async () => { throw new Error('AI unavailable'); } };
    const r = await answerCockpitChat('summarize', FACTS(), ai);
    expect(r.generated_by).toBe('deterministic');
    expect(r.answer).toMatch(/269 events on record/);
  });

  it('falls back to deterministic when the AI output is empty / too short', async () => {
    expect((await answerCockpitChat('x', FACTS(), { run: async () => ({ response: 'ok' }) })).generated_by).toBe('deterministic');
    expect((await answerCockpitChat('x', FACTS(), { run: async () => ({}) })).generated_by).toBe('deterministic');
  });
});

describe('cockpit chat Plane C — documents grounding (P1 · the "how do I add docs" felt-pain fix)', () => {
  const DOCS = [
    { filename: 'pricing-policy.md', excerpt: 'Our enterprise tier is priced at $2,400 per seat per year with a 20% multi-year discount.' },
    { filename: 'onboarding.txt', excerpt: 'New customers complete a 3-step readiness questionnaire before their first workspace.' },
  ];

  it('compileChatFacts surfaces the documents provenance (count + filenames)', () => {
    const g = compileChatFacts(FACTS({ documents: DOCS }));
    expect(g.documents.total).toBe(2);
    expect(g.documents.names).toEqual(['pricing-policy.md', 'onboarding.txt']);
  });

  it('feeds the document filename + real text INTO the LLM prompt (the model can finally answer FROM the docs)', async () => {
    let user = '';
    const ai: AiRunner = {
      run: async (_m, opts) => { user = opts.messages[1].content; return { response: 'A grounded answer long enough to clear the usable-output length floor for this test.' }; },
    };
    await answerCockpitChat('what is our enterprise price?', FACTS({ documents: DOCS }), ai);
    expect(user).toMatch(/pricing-policy\.md/);            // the doc is named in the prompt
    expect(user).toMatch(/\$2,400 per seat per year/);     // the REAL doc text is in the prompt → answerable
  });

  it('the deterministic floor surfaces documents even with NO events and NO AI binding', async () => {
    const r = await answerCockpitChat('what docs do I have?', { events: [], total: 0, documents: DOCS, scope: FACTS().scope });
    expect(r.generated_by).toBe('deterministic');
    expect(r.answer).toMatch(/documents on file/i);
    expect(r.answer).toMatch(/pricing-policy\.md/);
    expect(r.grounded_on.documents.total).toBe(2);
  });

  it('absent documents => zero provenance + answer byte-identical to before (purely additive)', () => {
    const g = compileChatFacts(FACTS());
    expect(g.documents).toEqual({ total: 0, names: [] });
    expect(buildDeterministicChatAnswer('summarize', g, FACTS().scope)).not.toMatch(/documents on file/i);
  });
});

describe('answerCockpitChat — P6 Claude premium tier (deep-research)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const LLAMA = '@cf/meta/llama-3.1-8b-instruct';
  const CLAUDE = 'claude-sonnet-4-6';
  const llamaAi: AiRunner = { run: async () => ({ response: 'A Llama answer that is comfortably long enough to clear the length floor for usable output.' }) };

  it('routes deep-research to Claude when a key is present — returns the Claude model + grounded provenance', async () => {
    let body: { system?: string; messages?: Array<{ content?: string }> } | null = null;
    globalThis.fetch = (async (_u: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'A thorough deep-research briefing grounded in the record: 269 items, recent cockpit clarity PRs, one awaiting sign-off, one blocked.' }] }) };
    }) as unknown as typeof fetch;
    const r = await answerCockpitChat('research this scope', FACTS(), llamaAi, 'deep-research', 'sk-ant-test');
    expect(r.generated_by).toBe('llm');
    expect(r.model).toBe(CLAUDE);
    expect(r.answer).toMatch(/deep-research briefing/);
    // Claude was fed the SAME no-invention grounded fact sheet as Llama
    expect(body!.system).toMatch(/never invent/i);
    expect(body!.messages![0].content).toMatch(/Total items on record: 269/);
    // provenance still computed from the real events
    expect(r.grounded_on.completed).toBe(3);
  });

  it('uses Claude when the user explicitly selects llm=claude (and a key is set)', async () => {
    let claudeCalled = false;
    globalThis.fetch = (async () => { claudeCalled = true; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'A real Claude-generated answer, comfortably longer than the forty-character usable floor.' }] }) }; }) as unknown as typeof fetch;
    const r = await answerCockpitChat('summarize', FACTS(), llamaAi, 'ask', 'sk-ant-test', 'claude');
    expect(claudeCalled).toBe(true);
    expect(r.model).toBe(CLAUDE);
  });

  it('DEFAULTS to free Llama for ask mode even when a key is set — Claude needs explicit opt-in', async () => {
    let claudeCalled = false;
    globalThis.fetch = (async () => { claudeCalled = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    const r = await answerCockpitChat('summarize', FACTS(), llamaAi, 'ask', 'sk-ant-test'); // no llm arg → default 'llama'
    expect(claudeCalled).toBe(false); // default is the free model; Claude only when the user picks it
    expect(r.model).toBe(LLAMA);
  });

  it('never calls Claude when NO Anthropic key is set, even if the user requests it', async () => {
    let claudeCalled = false;
    globalThis.fetch = (async () => { claudeCalled = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    const r = await answerCockpitChat('summarize', FACTS(), llamaAi, 'ask', undefined, 'claude');
    expect(claudeCalled).toBe(false);
    expect(r.model).toBe(LLAMA);
  });

  it('falls back to Llama when Claude fails (non-200) — never throws', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    const r = await answerCockpitChat('research', FACTS(), llamaAi, 'deep-research', 'sk-ant-test');
    expect(r.generated_by).toBe('llm');
    expect(r.model).toBe(LLAMA); // fell back to Llama, not a 5xx
  });

  it('no key configured → deep-research uses Llama (the premium tier is dormant)', async () => {
    let claudeCalled = false;
    globalThis.fetch = (async () => { claudeCalled = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    const r = await answerCockpitChat('research', FACTS(), llamaAi, 'deep-research');
    expect(claudeCalled).toBe(false);
    expect(r.model).toBe(LLAMA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plane B — the governance plane. The cockpit chat used to read ONLY operation_events and so
// answered "nothing blocked" while the project board showed packets "waiting · owner". These tests
// lock the merge: governance rows are classified EXACTLY as the board classifies them, scoped EXACTLY
// as the board scopes them, and the answer can no longer under-report what is waiting on the operator.
// Rows model the real MB-P operations-live-stream: evidence-ready packets titled "Owner confirmation".
const GOV_SCOPE: CockpitChatScope = { workspace_id: 'mbp-private', project_id: 'mbp-governance', domain_id: null };
function govRow(over: Partial<GovernanceStreamRow>): GovernanceStreamRow {
  return {
    row_id: 'pkt-1', stream_type: 'packet', state: 'evidence_ready',
    workspace_id: 'mbp-private', project_id: 'mbp-governance', domain_id: 'mbp-governance',
    timestamp_iso: '2026-06-09T09:00:00.000Z',
    title: 'Owner confirmation · MB-P skill registry', summary: 'Evidence ready; awaiting owner sign-off.',
    source_adapter: 'mbp-packet', evidence_refs: [{ uri: 'https://x/ev', label: 'ADR' }], ...over,
  };
}

describe('classifyGovernanceRow — board-identical (waiting·owner keys off the haystack, not bare state)', () => {
  it('an evidence-ready packet titled "Owner confirmation" is waiting·owner, like the board card', () => {
    expect(classifyGovernanceRow(govRow({}))).toBe('needsrev'); // state alone (evidence_ready) is NOT a review state
  });
  it('a blocked state is blocked', () => {
    expect(classifyGovernanceRow(govRow({ state: 'BLOCKED', title: 'ExpireStaleClaims' }))).toBe('blocked');
  });
  it('a plain running collaboration row is running', () => {
    expect(classifyGovernanceRow({ stream_type: 'collaboration_event', state: 'ClaimWork', title: 'Claim · work.push-safety' })).toBe('running');
  });
  it('an approved/passed row is healthy', () => {
    expect(classifyGovernanceRow({ stream_type: 'collaboration_event', state: 'PASS', title: 'PlanCheck' })).toBe('approved');
  });
});

describe('governanceRowInScope — most-specific scope wins (reproduces the exact cards the operator sees)', () => {
  it('a focused project matches that project ONLY (not the whole 50-row workspace)', () => {
    expect(governanceRowInScope(govRow({ project_id: 'mbp-governance' }), GOV_SCOPE)).toBe(true);
    expect(governanceRowInScope(govRow({ project_id: 'mbp-ops' }), GOV_SCOPE)).toBe(false); // same ws, different project → excluded
  });
  it('a whole-workspace scope (no project/domain) matches by workspace', () => {
    const wsScope: CockpitChatScope = { workspace_id: 'mbp-private', project_id: null, domain_id: null };
    expect(governanceRowInScope(govRow({ project_id: 'mbp-ops' }), wsScope)).toBe(true);
  });
  it('an unrelated tenant workspace shares no id and matches nothing', () => {
    const other: CockpitChatScope = { workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux', domain_id: null };
    expect(governanceRowInScope(govRow({}), other)).toBe(false);
  });

  // ARCH-006 W1.1 — operator-wide ("All my workspaces") makes Plane B span every owned workspace,
  // SYMMETRIC with the operator-wide Plane A read (HR-SCOPE-SYMMETRY-1). This is the fix for the
  // chief-of-staff answering "0 blocked" while real blockers sat in a DIFFERENT owned workspace.
  it('operator-wide (empty scope, operatorWide=true) matches a row from ANY owned workspace', () => {
    const wide: CockpitChatScope = { workspace_id: '', project_id: null, domain_id: null };
    expect(governanceRowInScope(govRow({ workspace_id: 'org_3EG82VEzc8t3t65XSZ0YDlcaDMI', project_id: 'p1' }), wide, true)).toBe(true);
    expect(governanceRowInScope(govRow({ workspace_id: 'mbp-private', project_id: 'p2' }), wide, true)).toBe(true);
  });
  it('default (operatorWide=false) preserves the historical empty-scope → false (no behavior change)', () => {
    const wide: CockpitChatScope = { workspace_id: '', project_id: null, domain_id: null };
    expect(governanceRowInScope(govRow({ workspace_id: 'org_3EG82' }), wide)).toBe(false);
    expect(governanceRowInScope(govRow({ workspace_id: 'org_3EG82' }), wide, false)).toBe(false);
  });
  it('a focused project STILL wins over operatorWide (most-specific scope is honored)', () => {
    expect(governanceRowInScope(govRow({ project_id: 'mbp-ops' }), GOV_SCOPE, true)).toBe(false); // GOV_SCOPE focuses mbp-governance
    expect(governanceRowInScope(govRow({ project_id: 'mbp-governance' }), GOV_SCOPE, true)).toBe(true);
  });
  it('mapGovernanceRowsToEvents(rows, emptyScope, true) maps rows from MULTIPLE workspaces', () => {
    const rows: GovernanceStreamRow[] = [
      govRow({ row_id: 'a', workspace_id: 'mbp-private', title: 'Owner confirmation · A' }),
      govRow({ row_id: 'b', workspace_id: 'org_3EG82VEzc8t3t65XSZ0YDlcaDMI', title: 'Owner confirmation · B' }),
    ];
    const wide: CockpitChatScope = { workspace_id: '', project_id: null, domain_id: null };
    expect(mapGovernanceRowsToEvents(rows, wide, true).length).toBe(2);
    expect(mapGovernanceRowsToEvents(rows, wide, false).length).toBe(0); // default unchanged
  });
});

describe('cockpit chat over BOTH planes — the trust fix', () => {
  // The operator's exact situation: a governance project with 0 activity events but 5 packets
  // waiting on their sign-off. Before the fix the chat said "nothing blocked".
  const FIVE_WAITING: GovernanceStreamRow[] = [1, 2, 3, 4, 5].map((n) =>
    govRow({ row_id: `pkt-${n}`, title: `Owner confirmation · packet ${n}` }));

  it('compileChatFacts merges planes: 0 events + 5 governance → needs_review 5, governance.waiting_owner 5', () => {
    const g = compileChatFacts({
      events: [], total: 0,
      governance: mapGovernanceRowsToEvents(FIVE_WAITING, GOV_SCOPE),
      scope: GOV_SCOPE,
    });
    expect(g.planes).toEqual({ events: 0, governance: 5 });
    expect(g.governance.total).toBe(5);
    expect(g.governance.waiting_owner).toBe(5);
    expect(g.needs_review).toBe(5);
    expect(g.events_total).toBe(5); // 0 activity + 5 governance — NOT zero
  });

  it('the answer NO LONGER says "nothing blocked / no activity" when governance items are waiting', () => {
    const g = compileChatFacts({
      events: [], total: 0,
      governance: mapGovernanceRowsToEvents(FIVE_WAITING, GOV_SCOPE),
      scope: GOV_SCOPE,
    });
    const a = buildDeterministicChatAnswer("what's blocked or needs my sign-off?", g, GOV_SCOPE);
    expect(a).not.toMatch(/no recorded activity/i);
    expect(a).not.toMatch(/you are clear/i);
    expect(a).toMatch(/5 items? (need|waiting)/i);
    expect(a).toMatch(/Governance/);
  });

  // ARCH-006 W3 — structured-fact grounding. The model receives a TYPED JSON block of the same items
  // (per-item reasoning: which is blocked, its project, whether it needs the operator) — not only prose.
  it('the LLM prompt carries a typed structured-fact block alongside the prose (case-11 moat)', async () => {
    let user = '';
    const ai: AiRunner = { run: async (_m, opts) => { user = opts.messages[1].content; return { response: 'Two governance packets await your sign-off; nothing is blocked right now in this scope.' }; } };
    await answerCockpitChat('what is blocked?', {
      events: [], total: 0, governance: mapGovernanceRowsToEvents(FIVE_WAITING, GOV_SCOPE), scope: GOV_SCOPE,
    }, ai);
    // the structured JSON block is present + typed
    expect(user).toMatch(/Structured facts \(typed records/);
    expect(user).toMatch(/"rollup"/);
    expect(user).toMatch(/"plane":"governance"/);
    expect(user).toMatch(/"needs_you":true/);
    // it is valid JSON we can parse back out of the prompt
    const m = user.match(/\{"scope"[\s\S]*?\}\s*\n\nOperator question:/);
    expect(m).not.toBeNull();
    const parsed = JSON.parse((m as RegExpMatchArray)[0].replace(/\s*\n\nOperator question:$/, ''));
    expect(parsed.rollup.governance).toBe(5);
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items[0]).toHaveProperty('status');
  });

  it('the LLM fact sheet carries the governance breakdown so the richer answer is equally truthful', async () => {
    let user = '';
    const ai: AiRunner = {
      run: async (_m, opts) => { user = opts.messages[1].content; return { response: 'Five governance packets are waiting on your sign-off; there is no blocked commit activity in this project right now.' }; },
    };
    await answerCockpitChat("what's waiting on me?", {
      events: [], total: 0, governance: mapGovernanceRowsToEvents(FIVE_WAITING, GOV_SCOPE), scope: GOV_SCOPE,
    }, ai);
    expect(user).toMatch(/governance/i);
    expect(user).toMatch(/5 waiting on the operator's sign-off/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wave 3b · pinned context cards. The operator attaches events/packets to a question (possibly from
// other scopes); the answer leads with them and grounds on them FIRST, then the scoped record.
describe('mapContextCardsToEvents — operator-pinned cards', () => {
  it('maps loose card fields (board-state or event-status) into the event shape', () => {
    const evs = mapContextCardsToEvents([
      { id: 'c1', title: 'Owner confirmation packet', state: 'needsrev', workspace_id: 'mbp-private', project_id: 'mbp-governance' },
      { id: 'c2', title: 'CI run', status: 'blocked', source: 'github', workspace_id: 'xcp-platform' },
    ]);
    expect(evs.length).toBe(2);
    expect(evs[0]).toMatchObject({ id: 'c1', status: 'needs_review', workspace_id: 'mbp-private', project_id: 'mbp-governance' });
    expect(evs[1]).toMatchObject({ id: 'c2', status: 'blocked', source_tool: 'github' });
  });
  it('is bounded to 12, skips empty/untitled cards, defaults status to needs_review', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, title: `card ${i}` }));
    expect(mapContextCardsToEvents(many).length).toBe(12);
    expect(mapContextCardsToEvents([{ id: 'x' }, null as never, { title: '' }]).length).toBe(0);
    expect(mapContextCardsToEvents([{ id: 'q', title: 'unknown thing' }])[0].status).toBe('needs_review');
  });
});

describe('cockpit chat with pinned cards', () => {
  const PINNED = mapContextCardsToEvents([
    { id: 'p1', title: 'x-biz investor packet · evidence ready', state: 'needsrev', workspace_id: 'x-biz' },
    { id: 'p2', title: 'mbp governance · waiting owner', state: 'needsrev', workspace_id: 'mbp-private' },
  ]);

  it('compileChatFacts surfaces pinned first + reports pinned_total, deduped from scope', () => {
    const g = compileChatFacts({
      events: COCKPIT_EVENTS, total: 269, governance: [], pinned: PINNED,
      scope: { workspace_id: 'org_3EG82', project_id: 'org_3EG82-cockpit-ux', domain_id: null },
    });
    expect(g.pinned_total).toBe(2);
    expect(g.pinned[0].summary).toMatch(/x-biz investor packet/);
    // pinned lead the named recent list
    expect(g.recent[0].summary).toMatch(/x-biz investor packet/);
    expect(g.recent[1].summary).toMatch(/mbp governance/);
    // both pinned count toward needs_review (they default to needs_review)
    expect(g.needs_review).toBeGreaterThanOrEqual(2);
  });

  it('the deterministic answer LEADS with the pinned cards', () => {
    const g = compileChatFacts({ events: COCKPIT_EVENTS, total: 269, pinned: PINNED, scope: FACTS().scope });
    const a = buildDeterministicChatAnswer('what is the status of these?', g, FACTS().scope);
    expect(a).toMatch(/You pinned 2 items to this question/);
    expect(a).toMatch(/x-biz investor packet/);
  });

  it('does NOT say "no recorded activity" when the scope is empty but cards are pinned (cross-context)', () => {
    const g = compileChatFacts({ events: [], total: 0, pinned: PINNED, scope: FACTS().scope });
    const a = buildDeterministicChatAnswer('summarize these', g, FACTS().scope);
    expect(a).not.toMatch(/no recorded activity in this project yet/);
    expect(a).toMatch(/You pinned 2 items/);
    expect(a).toMatch(/no other recorded activity/i);
  });

  it('feeds the pinned cards to the LLM as the FIRST facts to address', async () => {
    let user = '';
    const ai: AiRunner = { run: async (_m, opts) => { user = opts.messages[1].content; return { response: 'The two pinned items are both awaiting your sign-off; nothing else stands out.' }; } };
    await answerCockpitChat('status of the pinned items?', { events: COCKPIT_EVENTS, total: 269, pinned: PINNED, scope: FACTS().scope }, ai);
    expect(user).toMatch(/PINNED items the operator attached/);
    expect(user).toMatch(/x-biz investor packet/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OS-4 P4 · graph lineage around the pinned cards. The chat finally SEES the graph: the route
// resolves each pinned card to its graph node (intent:<id> / event:<id>) and passes the
// v_artefact_lineage neighborhood edges in facts.lineage. Strictly ADDITIVE: absent/[] must
// leave the prompt byte-identical to before (every earlier test in this file proves that arm).
describe('cockpit chat with pinned-card lineage (OS-4 P4)', () => {
  const PINNED = mapContextCardsToEvents([
    { id: 'p1', title: 'Ship the investor pack', state: 'needsrev', workspace_id: 'x-biz' },
  ]);
  const LINEAGE = [
    {
      workspace_id: 'x-biz', edge_from: 'intent:int-7', from_type: 'intent', from_description: 'Ship the investor pack',
      edge_to: 'event:evt-12', to_type: 'event', to_description: 'Draft uploaded to data room',
      edge_type: 'realizes', is_cause_edge: false,
    },
    {
      workspace_id: 'x-biz', edge_from: 'event:evt-3', from_type: 'event', from_description: 'Claim-safety gate failed',
      edge_to: 'event:evt-12', to_type: 'event', to_description: 'Draft uploaded to data room',
      edge_type: 'caused_by', is_cause_edge: true,
    },
  ];

  it('renders the lineage edges in BOTH prompt layers (typed block + prose)', async () => {
    let user = '';
    const ai: AiRunner = { run: async (_m, opts) => { user = opts.messages[1].content; return { response: 'The pinned intent is realized by the data-room upload; the gate failure is its recorded cause.' }; } };
    await answerCockpitChat('what led to this?', {
      events: COCKPIT_EVENTS, total: 269, pinned: PINNED, lineage: LINEAGE as never, scope: FACTS().scope,
    }, ai);
    // structured layer: typed edges with the cause marker
    expect(user).toMatch(/"lineage"/);
    expect(user).toMatch(/"edge":"realizes"/);
    expect(user).toMatch(/"cause":true/);
    // prose layer: legible edge lines using descriptions
    expect(user).toMatch(/LINEAGE around the pinned items/);
    expect(user).toMatch(/Ship the investor pack -\[realizes\]-> Draft uploaded to data room/);
    expect(user).toMatch(/Claim-safety gate failed -\[caused_by\]-> Draft uploaded to data room/);
  });

  it('ADDITIVE: absent and empty lineage produce the identical prompt (no lineage trace)', async () => {
    const grab = async (facts: Record<string, unknown>) => {
      let user = '';
      const ai: AiRunner = { run: async (_m, opts) => { user = opts.messages[1].content; return { response: 'The pinned item awaits your sign-off; nothing else is outstanding here.' }; } };
      await answerCockpitChat('status?', facts as never, ai);
      return user;
    };
    const base = { events: COCKPIT_EVENTS, total: 269, pinned: PINNED, scope: FACTS().scope };
    const absent = await grab(base);
    const empty = await grab({ ...base, lineage: [] });
    expect(absent).toBe(empty);
    expect(absent).not.toMatch(/lineage/i);
  });
});
