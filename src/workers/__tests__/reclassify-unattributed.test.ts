// reclassify-unattributed.test.ts
//
// Unit tests for the SELF-HEALING reclassification backstop cron
// (crons/reclassify-unattributed.ts) — the backstop to the going-forward
// producer (PR #517). DAL fully mocked (mirror scheduled-digest-sweep test
// style). Asserts the safety + correctness contract:
//   (1) flag OFF (default)            → status skipped, ZERO DB calls, 0 actions.
//   (2) unattributed event in a SPLIT workspace → re-filed to `${ws}-<slug>`,
//       per-bucket tally + workspaces_touched reflect it.
//   (3) event in a NON-split workspace → untouched (scope guard: the workspace
//       never appears in listSplitEnabledWorkspaceIds, so it's invisible).
//   (4) already-attributed event       → untouched (it's not in the backlog the
//       store returns; the UPDATE is also guarded so a stray row is a no-op).
//   (5) unknown-slug / missing project  → safely skipped (skipped_missing_project,
//       NO reassignEventProject call → no FK error).
//   (6) never-throws                    → one event whose UPDATE throws is
//       isolated + counted; the batch completes.

import { describe, it, expect, vi } from 'vitest';
import { reclassifyUnattributedCron, MAX_BATCH } from '../crons/reclassify-unattributed';

const NOW = () => new Date('2026-06-09T12:45:00.000Z');
const WS = 'org_split_workspace';

interface FakeEvent { id: string; workspace_id: string; summary: string }

/**
 * A minimal DAL double covering only the four methods the cron touches, plus
 * per-call spies. `existingProjectIds` is the FK-safety set; `events` is the
 * unattributed backlog the store would return for the split workspaces.
 */
function makeDal(opts: {
  splitWorkspaceIds: string[];
  events: FakeEvent[];
  existingProjectIds: string[];
  reassignImpl?: (ws: string, id: string, projectId: string) => Promise<number>;
}) {
  const listSplitEnabledWorkspaceIds = vi.fn(async () => opts.splitWorkspaceIds);
  const listUnattributedEvents = vi.fn(async (_ids: string[], _limit: number) => opts.events);
  const listProjectIdsForWorkspaces = vi.fn(async (_ids: string[]) => new Set(opts.existingProjectIds));
  const reassignEventProject = vi.fn(
    opts.reassignImpl ?? (async (_ws: string, _id: string, _projectId: string) => 1),
  );
  return {
    dal: {
      listSplitEnabledWorkspaceIds,
      listUnattributedEvents,
      listProjectIdsForWorkspaces,
      reassignEventProject,
    } as any,
    spies: { listSplitEnabledWorkspaceIds, listUnattributedEvents, listProjectIdsForWorkspaces, reassignEventProject },
  };
}

/** The 8 canonical projects exist in WS (so any classifier slug is FK-safe there). */
const ALL_EIGHT = [
  'cockpit-ux', 'event-pipeline', 'infra-deploy', 'governance',
  'onboarding', 'commercial-gtm', 'investor', 'funnel',
].map((s) => `${WS}-${s}`);

describe('reclassifyUnattributedCron · self-healing backstop', () => {
  // (1) SAFE-BY-DEFAULT
  it('flag OFF (default) → status skipped, reason flag_disabled, ZERO DB calls', async () => {
    const { dal, spies } = makeDal({ splitWorkspaceIds: [WS], events: [], existingProjectIds: ALL_EIGHT });
    const res = await reclassifyUnattributedCron({ dal, now: NOW, cronExpression: '45 * * * *' });
    expect(res.status).toBe('skipped');
    expect(res.actions_taken).toBe(0);
    expect((res.metadata as { reason?: string }).reason).toBe('flag_disabled');
    // Inert: not a single DB method was touched.
    expect(spies.listSplitEnabledWorkspaceIds).not.toHaveBeenCalled();
    expect(spies.listUnattributedEvents).not.toHaveBeenCalled();
    expect(spies.listProjectIdsForWorkspaces).not.toHaveBeenCalled();
    expect(spies.reassignEventProject).not.toHaveBeenCalled();
  });

  it('flag present but not truthy → still a no-op (only tolerant-true enables)', async () => {
    const { dal, spies } = makeDal({ splitWorkspaceIds: [WS], events: [], existingProjectIds: ALL_EIGHT });
    // J-W0 (260711-I / FGH-2): the cron now reads the flag via envFlagTrue, so genuinely-non-true
    // values stay a no-op, but quote/whitespace/case variants of "true" DO enable (the fix — a
    // dashboard-entered `"true"` must engage). These are the still-disabled values.
    for (const val of ['1', 'yes', 'on', 'enabled', 'false', '']) {
      spies.listSplitEnabledWorkspaceIds.mockClear();
      const res = await reclassifyUnattributedCron({
        dal, now: NOW, cronExpression: '45 * * * *', env: { RECLASSIFY_CRON_ENABLED: val },
      });
      expect(res.status).toBe('skipped');
      expect(spies.listSplitEnabledWorkspaceIds).not.toHaveBeenCalled();
    }
    // tolerant-true — case, trailing whitespace, and surrounding quotes ALL enable (envFlagTrue).
    for (const val of ['TRUE', 'TRUE ', '"true"', "'true'", ' true ']) {
      spies.listSplitEnabledWorkspaceIds.mockClear();
      const res = await reclassifyUnattributedCron({
        dal, now: NOW, cronExpression: '45 * * * *', env: { RECLASSIFY_CRON_ENABLED: val },
      });
      expect(res.status).toBe('completed');
      expect(spies.listSplitEnabledWorkspaceIds).toHaveBeenCalledTimes(1);
    }
  });

  // (2) the happy path — an unattributed event in a split workspace is re-filed.
  it('flag ON + unattributed event in a split workspace → re-filed to the right ${ws}-<slug>', async () => {
    const { dal, spies } = makeDal({
      splitWorkspaceIds: [WS],
      events: [
        { id: 'evt_a', workspace_id: WS, summary: '[mar23/repo] feat(investor): pitch deck v3 + data room' },
        { id: 'evt_b', workspace_id: WS, summary: '[mar23/repo] feat(R54-Stage1): GitHub webhook producer — ingest commits' },
        { id: 'evt_c', workspace_id: WS, summary: '[mar23/repo] tweak whitespace' }, // ambiguous → default cockpit-ux (no paths post-hoc)
      ],
      existingProjectIds: ALL_EIGHT,
    });
    const res = await reclassifyUnattributedCron({
      dal, now: NOW, cronExpression: '45 * * * *', env: { RECLASSIFY_CRON_ENABLED: 'true' },
    });

    expect(res.status).toBe('completed');
    expect(res.actions_taken).toBe(3);

    // each event re-filed to the classifier's slug.
    expect(spies.reassignEventProject).toHaveBeenCalledWith(WS, 'evt_a', `${WS}-investor`);
    expect(spies.reassignEventProject).toHaveBeenCalledWith(WS, 'evt_b', `${WS}-event-pipeline`);
    // "tweak whitespace" with NO changed paths (post-hoc) → cockpit-ux default.
    expect(spies.reassignEventProject).toHaveBeenCalledWith(WS, 'evt_c', `${WS}-cockpit-ux`);

    const meta = res.metadata as {
      workspaces_touched: number; reclassified: number; buckets: Record<string, number>;
    };
    expect(meta.reclassified).toBe(3);
    expect(meta.workspaces_touched).toBe(1);
    expect(meta.buckets.investor).toBe(1);
    expect(meta.buckets['event-pipeline']).toBe(1);
    expect(meta.buckets['cockpit-ux']).toBe(1);
  });

  // (3) NON-split workspace → never touched (scope guard).
  it('event in a NON-split workspace → untouched (workspace not in the split set)', async () => {
    // The store would only return events for split workspaces; the scope guard
    // is listSplitEnabledWorkspaceIds. Here NO workspace opted in → empty set.
    const { dal, spies } = makeDal({ splitWorkspaceIds: [], events: [], existingProjectIds: [] });
    const res = await reclassifyUnattributedCron({
      dal, now: NOW, cronExpression: '45 * * * *', env: { RECLASSIFY_CRON_ENABLED: 'true' },
    });
    expect(res.status).toBe('completed');
    expect(res.actions_taken).toBe(0);
    expect(res.notes).toMatch(/no split-enabled workspaces/);
    // We short-circuit BEFORE scanning events or fetching projects.
    expect(spies.listUnattributedEvents).not.toHaveBeenCalled();
    expect(spies.listProjectIdsForWorkspaces).not.toHaveBeenCalled();
    expect(spies.reassignEventProject).not.toHaveBeenCalled();
  });

  // (4) already-attributed event → untouched.
  it('already-attributed events are not in the backlog → nothing re-filed', async () => {
    // The store returns only unattributed rows; an already-attributed workspace
    // therefore yields an empty backlog → zero re-files, zero UPDATEs.
    const { dal, spies } = makeDal({ splitWorkspaceIds: [WS], events: [], existingProjectIds: ALL_EIGHT });
    const res = await reclassifyUnattributedCron({
      dal, now: NOW, cronExpression: '45 * * * *', env: { RECLASSIFY_CRON_ENABLED: 'true' },
    });
    expect(res.status).toBe('completed');
    expect(res.actions_taken).toBe(0);
    expect(spies.listUnattributedEvents).toHaveBeenCalledTimes(1);
    expect(spies.reassignEventProject).not.toHaveBeenCalled();
  });

  // (5) unknown-slug / missing project → safely skipped (no FK error).
  it('target project does NOT exist → skipped (no reassign call → no FK error)', async () => {
    const { dal, spies } = makeDal({
      splitWorkspaceIds: [WS],
      events: [
        // classifies to 'investor' but that project row is MISSING in this workspace.
        { id: 'evt_x', workspace_id: WS, summary: '[mar23/repo] feat(investor): data room' },
        // classifies to 'cockpit-ux' which DOES exist → this one re-files.
        { id: 'evt_y', workspace_id: WS, summary: '[mar23/repo] tweak whitespace' },
      ],
      // Only cockpit-ux exists; investor does not.
      existingProjectIds: [`${WS}-cockpit-ux`],
    });
    const res = await reclassifyUnattributedCron({
      dal, now: NOW, cronExpression: '45 * * * *', env: { RECLASSIFY_CRON_ENABLED: 'true' },
    });
    expect(res.status).toBe('completed');
    const meta = res.metadata as { reclassified: number; skipped_missing_project: number };
    expect(meta.skipped_missing_project).toBe(1);
    expect(meta.reclassified).toBe(1);
    // the missing-project event NEVER hit reassignEventProject (FK-safe).
    expect(spies.reassignEventProject).not.toHaveBeenCalledWith(WS, 'evt_x', `${WS}-investor`);
    expect(spies.reassignEventProject).toHaveBeenCalledWith(WS, 'evt_y', `${WS}-cockpit-ux`);
    expect(spies.reassignEventProject).toHaveBeenCalledTimes(1);
  });

  // (6) NEVER-THROWS — one event whose UPDATE throws is isolated; the batch completes.
  it('a single reassign that throws → errors++, batch continues + completes', async () => {
    const { dal } = makeDal({
      splitWorkspaceIds: [WS],
      events: [
        { id: 'evt_ok1', workspace_id: WS, summary: 'tweak whitespace' },          // cockpit-ux
        { id: 'evt_boom', workspace_id: WS, summary: 'feat(investor): data room' }, // investor → throws
        { id: 'evt_ok2', workspace_id: WS, summary: 'feat(onboarding): provisioner' }, // onboarding
      ],
      existingProjectIds: ALL_EIGHT,
      reassignImpl: async (_ws, id) => {
        if (id === 'evt_boom') throw new Error('update blew up');
        return 1;
      },
    });
    const res = await reclassifyUnattributedCron({
      dal, now: NOW, cronExpression: '45 * * * *', env: { RECLASSIFY_CRON_ENABLED: 'true' },
    });
    // OBS-2 (J-W3): never throws at the batch level, but errors>0 → 'degraded' (reported to Sentry),
    // no longer a silent 'completed'. The batch still completes and re-files the healthy events.
    expect(res.status).toBe('degraded');
    const meta = res.metadata as { errors: number; reclassified: number };
    expect(meta.errors).toBe(1);
    expect(meta.reclassified).toBe(2); // the two healthy events still re-filed
  });

  // bounded batch — store is asked for at most MAX_BATCH rows.
  it('passes MAX_BATCH as the bound to the unattributed-backlog read', async () => {
    const { dal, spies } = makeDal({ splitWorkspaceIds: [WS], events: [], existingProjectIds: ALL_EIGHT });
    await reclassifyUnattributedCron({
      dal, now: NOW, cronExpression: '45 * * * *', env: { RECLASSIFY_CRON_ENABLED: 'true' },
    });
    expect(spies.listUnattributedEvents).toHaveBeenCalledWith([WS], MAX_BATCH);
    expect(MAX_BATCH).toBe(500);
  });

  // top-level failure is swallowed → status failed, never throws.
  it('a top-level listSplitEnabledWorkspaceIds failure → status failed, no throw', async () => {
    const dal = {
      listSplitEnabledWorkspaceIds: vi.fn(async () => { throw new Error('db down'); }),
      listUnattributedEvents: vi.fn(),
      listProjectIdsForWorkspaces: vi.fn(),
      reassignEventProject: vi.fn(),
    } as any;
    const res = await reclassifyUnattributedCron({
      dal, now: NOW, cronExpression: '45 * * * *', env: { RECLASSIFY_CRON_ENABLED: 'true' },
    });
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/db down/);
    expect(res.actions_taken).toBe(0);
  });
});
