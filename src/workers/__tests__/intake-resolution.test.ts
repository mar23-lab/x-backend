import { describe, expect, it } from 'vitest';
import { buildIntakeResolution } from '../lib/intake-resolution';

const now = new Date('2026-07-15T00:00:00.000Z');
const packet = (id: string, version = 1) => ({
  id, workspace_id: 'tenant_a', project_id: null, event_id: null, title: `Work ${id}`, summary: 'Scoped work',
  lifecycle_state: 'ready', actor_user_id: 'user_op', allowed_tools: [], forbidden_tools: [], source_refs: [],
  evidence_ref_ids: [], approval_required: true, version, requested_output: null, acceptance_criteria: [],
  acceptance_status: 'pending', evidence_required: true, execution_status: 'pending', blockers_accepted: false,
  receipt_required: true, plan_projection_required: true, plan_projection_updated_at: null, completed_at: null,
  expires_at: null, created_at: now.toISOString(), updated_at: now.toISOString(),
} as const);

const inventory = (packets: any[] = [], approvals: any[] = []) => ({
  packets,
  approvals,
  authorityFor: () => ({ allowed: true, safe_reason: 'active_entitlement' }),
  now,
});

describe('canonical intake resolution', () => {
  it('answers read-only questions without creating work', () => {
    const row = buildIntakeResolution({ text: 'What changed today?', client_request_id: 'c1' }, 'a'.repeat(64), inventory());
    expect(row).toMatchObject({ operation: 'answer', next_step: 'answer_now', requires_confirmation: false });
  });

  it('honours explicit no-change language in a workspace summary request', () => {
    const text = 'What is currently in this workspace? Summarize the active projects, connected sources, and recorded events. State what is grounded, include freshness, and do not create or change anything.';
    const row = buildIntakeResolution({ text, client_request_id: 'c-readonly-account' }, '1'.repeat(64), inventory());
    expect(row).toMatchObject({
      operation: 'answer',
      next_step: 'answer_now',
      requires_confirmation: false,
      target: { type: 'read_model' },
      effect_summary: 'Answer from governed workspace facts without creating work.',
    });
  });

  it('returns a draft plan without creating governed work', () => {
    const row = buildIntakeResolution({ text: 'Plan the next release', client_request_id: 'c2' }, 'b'.repeat(64), inventory());
    expect(row).toMatchObject({ operation: 'plan', next_step: 'draft_plan', requires_confirmation: false });
  });

  it('previews one new work item and requires confirmation', () => {
    const row = buildIntakeResolution({ text: 'Create a task to verify Gmail sync', client_request_id: 'c3' }, 'c'.repeat(64), inventory());
    expect(row).toMatchObject({ operation: 'create_work', next_step: 'confirm', requires_confirmation: true, risk: 'medium' });
  });

  it('never silently chooses among multiple active work items', () => {
    const row = buildIntakeResolution({ text: 'Continue', client_request_id: 'c4' }, 'd'.repeat(64), inventory([packet('p1'), packet('p2')]));
    expect(row).toMatchObject({ operation: 'continue_work', next_step: 'clarify', ambiguity: true, requires_confirmation: false });
  });

  it('binds continue to the selected packet version', () => {
    const row = buildIntakeResolution({ text: 'Continue', client_request_id: 'c5', target: { type: 'task_packet', id: 'p2' } }, 'e'.repeat(64), inventory([packet('p1'), packet('p2', 4)]));
    expect(row).toMatchObject({ next_step: 'confirm', current_work_version: 4, action_payload: { packet_id: 'p2', packet_version: 4 } });
  });

  it('never silently approves among multiple pending approvals', () => {
    const approvals = [
      { id: 'a1', status: 'requested', reason: 'First' },
      { id: 'a2', status: 'requested', reason: 'Second' },
    ];
    const row = buildIntakeResolution({ text: 'Approve', client_request_id: 'c6' }, 'f'.repeat(64), inventory([], approvals));
    expect(row).toMatchObject({ operation: 'decide', next_step: 'clarify', ambiguity: true, requires_confirmation: false });
  });
});
