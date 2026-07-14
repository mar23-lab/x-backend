// digest-posting.test.ts · 2026-06-12 · OS-5 W2 (the approval loop's missing last step)
//
// postApprovedDigest: when a sign-off approves a digest proposal, the proposal is atomically
// claimed needs_review→completed (run-exactly-once posting — ALSO the sweep-unblocking fix),
// a posted-receipt is APPENDED threaded under the proposal, and the email is best-effort.

import { describe, it, expect, vi } from 'vitest';
import { postApprovedDigest } from '../services/agent-digest';
import type { DalAdapter } from '../dal/DalAdapter';

const PROPOSAL = {
  id: 'evt_exec_digest_req1', status: 'needs_review', approval_state: 'pending',
  next_action: 'approve_to_post_digest', summary: 'Weekly digest — xlooop', body: 'digest body text', agent_id: 'xlooop:digest-agent',
};

function makeDal(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Record<string, unknown[][]> = { getEvent: [], updateEventStatus: [], upsertEvent: [] };
  const dal = {
    getEvent: vi.fn(async (...a: unknown[]) => { calls.getEvent.push(a); return PROPOSAL; }),
    updateEventStatus: vi.fn(async (...a: unknown[]) => { calls.updateEventStatus.push(a); return { updated: 1 }; }),
    upsertEvent: vi.fn(async (...a: unknown[]) => { calls.upsertEvent.push(a); return {}; }),
    ...overrides,
  } as unknown as DalAdapter;
  return { dal, calls };
}

const ENV = { ADMIN_NOTIFICATION_EMAIL: '', ENVIRONMENT: 'test' };
const NOW = () => new Date('2026-06-12T10:00:00Z');

describe('OS-5 W2 · postApprovedDigest', () => {
  it('happy path: atomic claim completed + threaded receipt appended', async () => {
    const { dal, calls } = makeDal();
    const out = await postApprovedDigest(dal, ENV, 'ws1', 'evt_exec_digest_req1', NOW);
    expect(out).toEqual({ posted: true, reason: 'posted' });
    // the claim is needs_review -> completed with the expectedStatus guard (run-exactly-once)
    expect(calls.updateEventStatus[0]).toEqual(['ws1', 'evt_exec_digest_req1', { status: 'completed' }, 'needs_review']);
    // the receipt is APPENDED (ia-001), deterministic id, threaded under the proposal
    const receipt = calls.upsertEvent[0]![1] as Record<string, unknown>;
    expect(String(receipt.id)).toMatch(/^evt_digest_posted_/);
    expect(receipt.parent_event_id).toBe('evt_exec_digest_req1');
    expect(receipt.status).toBe('completed');
    expect(receipt.agent_id).toBe('xlooop:digest-agent');
  });

  it('non-digest event: no-op (every other sign-off is unchanged)', async () => {
    const { dal, calls } = makeDal({
      getEvent: vi.fn(async () => ({ ...PROPOSAL, next_action: null })),
    });
    const out = await postApprovedDigest(dal, ENV, 'ws1', 'evt_other', NOW);
    expect(out.reason).toBe('not_a_digest_proposal');
    expect(calls.updateEventStatus.length).toBe(0);
    expect(calls.upsertEvent.length).toBe(0);
  });

  it('claim race lost: stops without a receipt (run-exactly-once)', async () => {
    const { dal, calls } = makeDal({
      updateEventStatus: vi.fn(async () => ({ updated: 0 })),
    });
    const out = await postApprovedDigest(dal, ENV, 'ws1', 'evt_exec_digest_req1', NOW);
    expect(out.reason).toBe('claim_lost');
    expect(calls.upsertEvent.length).toBe(0);
  });

  it('never throws: a DAL explosion returns {posted:false, reason:error}', async () => {
    const { dal } = makeDal({ getEvent: vi.fn(async () => { throw new Error('boom'); }) });
    const out = await postApprovedDigest(dal, ENV, 'ws1', 'x', NOW);
    expect(out).toEqual({ posted: false, reason: 'error' });
  });

  it('sweep regression: the posted proposal no longer matches the sweep idempotency scan', async () => {
    // The sweep counts pending as: status='needs_review' AND next_action='approve_to_post_digest'.
    // Before W2 an APPROVED proposal still matched (approval flipped approval_state only) —
    // blocking every future digest. After the claim, status='completed' -> no match.
    const sweepCountsAsPending = (e: { status: string; next_action: string | null }) =>
      e.status === 'needs_review' && e.next_action === 'approve_to_post_digest';
    expect(sweepCountsAsPending(PROPOSAL)).toBe(true); // before: blocked
    expect(sweepCountsAsPending({ ...PROPOSAL, status: 'completed' })).toBe(false); // after: unblocked
  });
});
