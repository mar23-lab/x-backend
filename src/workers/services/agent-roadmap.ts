// agent-roadmap.ts · the second governed "agent does real work" verb (W3 Track A · executor-verbs).
//
// A deterministic agent that SYNTHESIZES a roadmap proposal from the workspace plan
// (domains → roadmaps + goals, via dal.listWorkspacePlan), posted as a PENDING proposal
// (status='needs_review', approval_state='pending') into the existing approval spine — the operator
// vets it before it becomes official. It is the exact sibling of agent-digest.ts: read DAL → draft →
// governed proposal → operator POST /sign-offs approves. The distinction is the LENS: digest snapshots
// ACTIVITY; roadmap synthesizes the PLAN — it organizes the workspace's goals + roadmaps and flags the
// gaps (goals with no roadmap, roadmaps with no movement) so the operator gets a "where does the plan
// stand + what's the next planning move" draft to approve.
//
// WHY this verb (vs goal/intent): /goal + /intent are already the chat SLASH-command proposal path
// (operator-capture.js parseSlashCommand) — the human DECLARES a goal/intent. An executor `roadmap`
// verb is the AGENT SYNTHESIZING across those declarations; it does not collide with the slash path,
// and it fills `/roadmap` — cataloged in the production-state model but previously unimplemented.
//
// Deterministic v1 (no LLM): pure, fully unit-testable, no model dependency. An LLM-richer draft can
// follow later through the SAME proposal → approve loop (mirroring buildWorkspaceDigestLLM), never
// posting anything official without human sign-off. Customer-safe vocabulary.

import type { WorkspacePlanDomain } from '../dal/roadmap-store';

export interface RoadmapProposal {
  summary: string;
  body: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Compile a roadmap-synthesis proposal from the workspace plan. Pure + deterministic — same contract
 * as buildWorkspaceDigest. Counts roadmaps + goals + item progress across domains, and surfaces the
 * two planning gaps an operator most wants flagged: goals with NO roadmap, and roadmaps with NO items
 * done yet. Never throws on empty input (an empty plan yields an honest "no plan yet" draft).
 */
export function buildWorkspaceRoadmap(domains: WorkspacePlanDomain[]): RoadmapProposal {
  const safe = Array.isArray(domains) ? domains : [];
  const roadmaps = safe.flatMap((d) => (Array.isArray(d.roadmaps) ? d.roadmaps : []));
  const goals = safe.flatMap((d) => (Array.isArray(d.goals) ? d.goals : []));
  const itemsTotal = roadmaps.reduce((n, r) => n + (r.items_total || 0), 0);
  const itemsDone = roadmaps.reduce((n, r) => n + (r.items_done || 0), 0);
  const activeGoals = goals.filter((g) => g.status === 'active');

  // Planning gaps the agent flags for the operator: domains that have goals but NO roadmap to deliver
  // them, and roadmaps that exist but have moved 0 items — the two "stalled plan" signals.
  const domainsWithGoalsNoRoadmap = safe.filter(
    (d) => (d.goals || []).length > 0 && (d.roadmaps || []).length === 0,
  );
  const stalledRoadmaps = roadmaps.filter((r) => (r.items_total || 0) > 0 && (r.items_done || 0) === 0);

  if (roadmaps.length === 0 && goals.length === 0) {
    return {
      summary: 'Roadmap synthesis · no plan on record yet',
      body: [
        'I looked across your workspace and there are no roadmaps or goals on record yet.',
        '',
        'A first planning move: declare a goal (what outcome you want) and a roadmap (the steps to get there)',
        'on a domain, and I can synthesize progress + flag gaps for you here each time you ask.',
      ].join('\n'),
    };
  }

  const lines: string[] = [
    'Here is a synthesis of your plan, compiled for you:',
    `• ${plural(roadmaps.length, 'roadmap')} across ${plural(safe.length, 'domain')} · ${itemsDone}/${itemsTotal} steps done`,
    `• ${plural(goals.length, 'goal')} (${plural(activeGoals.length, 'active')})`,
  ];
  if (domainsWithGoalsNoRoadmap.length > 0) {
    lines.push(
      `• ${plural(domainsWithGoalsNoRoadmap.length, 'domain')} have goals but no roadmap to deliver them` +
        ` (${domainsWithGoalsNoRoadmap.map((d) => d.label).slice(0, 3).join(', ')}${domainsWithGoalsNoRoadmap.length > 3 ? '…' : ''})`,
    );
  }
  if (stalledRoadmaps.length > 0) {
    lines.push(`• ${plural(stalledRoadmaps.length, 'roadmap')} have no steps done yet — candidates to start or re-scope`);
  }
  if (activeGoals.length > 0) {
    lines.push('', 'Active goals:');
    for (const g of activeGoals.slice(0, 6)) {
      const metric = g.target_value != null
        ? ` (${g.current_value ?? 0}/${g.target_value}${g.metric_unit ? ' ' + g.metric_unit : ''})`
        : '';
      lines.push(`  – ${g.title}${metric}`);
    }
  }
  lines.push('', 'Approve to post this roadmap synthesis to your operations stream as a governed record, or reject to discard.');

  return {
    summary: `Roadmap synthesis · ${plural(roadmaps.length, 'roadmap')} · ${itemsDone}/${itemsTotal} steps done`,
    body: lines.join('\n'),
  };
}
