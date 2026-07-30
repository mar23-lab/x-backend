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

const project = (id: string, name: string) => ({
  id, workspace_id: 'tenant_a', name, status: 'active', description: null, metadata: {},
  scope_binding: null, scope_binding_updated_at: null, scope_binding_updated_by: null,
  parent_project_id: null, created_at: now.toISOString(), updated_at: now.toISOString(),
});

const inventory = (packets: any[] = [], approvals: any[] = [], projects: any[] = []) => ({
  packets,
  approvals,
  projects,
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

  it.each([
    'Live verification 2026-07-24: summarize the current workspace status and identify any blocked work. Do not create, approve, edit, or delete governed work.',
    'What is the current status of Honest & Young Operations? Summarize active work and blockers using workspace records. Read only: do not create or modify work.',
    '[PROD OWNER DIAGNOSTIC 2026-07-30 READ-ONLY] For this selected project only, return the exact project name, every current goal, milestone count, todo count, and each fact source/freshness. Do not create, edit, approve, connect, sync, or execute anything.',
  ])('keeps live read-only reproduction text on the answer-now path: %s', (text) => {
    const row = buildIntakeResolution({ text, client_request_id: 'c-live-readonly' }, '2'.repeat(64), inventory());
    expect(row).toMatchObject({
      operation: 'inspect',
      next_step: 'answer_now',
      requires_confirmation: false,
      target: { type: 'read_model' },
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

  it('binds an explicitly named project and quoted title to canonical preview data', () => {
    const text = 'Create a reversible todo in Honest & Young · Operations titled "Verify governed receipt 2026-07-27". Execute only after explicit approval.';
    const row = buildIntakeResolution(
      { text, client_request_id: 'c3-project' },
      '3'.repeat(64),
      inventory([], [], [project('proj_honest-young_default', 'Honest & Young · Operations')]),
    );
    expect(row).toMatchObject({
      operation: 'create_work',
      next_step: 'confirm',
      ambiguity: false,
      project_id: 'proj_honest-young_default',
      target: {
        type: 'task_packet',
        label: 'Verify governed receipt 2026-07-27 in Honest & Young · Operations (proj_honest-young_default)',
      },
      effect_summary: 'Create one governed work item in Honest & Young · Operations (proj_honest-young_default): Verify governed receipt 2026-07-27',
      action_payload: {
        title: 'Verify governed receipt 2026-07-27',
        project_id: 'proj_honest-young_default',
        project_name: 'Honest & Young · Operations',
      },
    });
  });

  it('binds a parenthesized canonical project id without treating it as part of the project name', () => {
    const text = 'Create a reversible todo in Honest & Young · Operations (proj_honest-young_default) titled "Verify canonical receipt".';
    const row = buildIntakeResolution(
      { text, client_request_id: 'c3-canonical-id' },
      '6'.repeat(64),
      inventory([], [], [project('proj_honest-young_default', 'Honest & Young · Operations')]),
    );
    expect(row).toMatchObject({
      next_step: 'confirm',
      ambiguity: false,
      project_id: 'proj_honest-young_default',
      target: {
        label: 'Verify canonical receipt in Honest & Young · Operations (proj_honest-young_default)',
      },
      action_payload: {
        title: 'Verify canonical receipt',
        project_id: 'proj_honest-young_default',
        project_name: 'Honest & Young · Operations',
      },
    });
  });

  it('asks for clarification when text contains more than one active canonical project id', () => {
    const row = buildIntakeResolution(
      { text: 'Create a task for proj_alpha and proj_beta titled "Do not guess".', client_request_id: 'c3-many-project-ids' },
      '7'.repeat(64),
      inventory([], [], [project('proj_alpha', 'Alpha'), project('proj_beta', 'Beta')]),
    );
    expect(row).toMatchObject({
      next_step: 'clarify',
      ambiguity: true,
      requires_confirmation: false,
      action_payload: {},
    });
  });

  it('asks one clarification when a named project cannot be resolved', () => {
    const row = buildIntakeResolution(
      { text: 'Create a todo in Missing Project titled "Do not guess".', client_request_id: 'c3-missing-project' },
      '4'.repeat(64),
      inventory([], [], [project('proj_known', 'Known Project')]),
    );
    expect(row).toMatchObject({
      operation: 'create_work',
      next_step: 'clarify',
      ambiguity: true,
      requires_confirmation: false,
      target: { type: 'none', id: null, label: 'Project clarification required' },
      action_payload: {},
    });
  });

  it('does not bind a project mentioned only inside the requested title', () => {
    const row = buildIntakeResolution(
      { text: 'Create a todo in Missing Project titled "Review Known Project".', client_request_id: 'c3-title-project' },
      '5'.repeat(64),
      inventory([], [], [project('proj_known', 'Known Project')]),
    );
    expect(row).toMatchObject({
      next_step: 'clarify',
      ambiguity: true,
      target: { type: 'none', id: null },
      action_payload: {},
    });
  });

  it('does not bind a canonical project id mentioned only inside the requested title', () => {
    const row = buildIntakeResolution(
      { text: 'Create a todo titled "Review proj_known".', client_request_id: 'c3-title-project-id' },
      '8'.repeat(64),
      inventory([], [], [project('proj_known', 'Known Project')]),
    );
    expect(row).toMatchObject({
      next_step: 'confirm',
      ambiguity: false,
      project_id: null,
      target: { label: 'Review proj_known' },
      action_payload: { title: 'Review proj_known', project_id: null },
    });
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
