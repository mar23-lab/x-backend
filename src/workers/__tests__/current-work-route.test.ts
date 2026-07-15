import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { currentWorkRoute } from '../routes/current-work';

// Mock dal: getSession returns one project; listEvents returns a fixture event stream.
function mkDal(events: any[]) {
  return {
    getSession: async () => ({ projects: [{ id: 'prj_1', name: 'P1' }], workspace: { id: 'ws_1' }, user: { role: 'operator' } }),
    listEvents: async () => ({ events, pagination: { has_more: false, next_before: null } }),
  } as any;
}
const AUTH = { user_id: 'u_1', workspace_id: 'ws_1', role: 'operator', email: 'o@x.com', service_principal: false } as any;

function app(events: any[], flag: string | undefined) {
  const a = new Hono();
  a.use('*', async (ctx, next) => {
    ctx.env = { CURRENT_WORK_PROJECTION_ENABLED: flag } as any;
    ctx.set('auth', AUTH);
    ctx.set('dal', mkDal(events));
    ctx.set('request_id', 'rq_1');
    await next();
  });
  a.route('/', currentWorkRoute);
  return a;
}
const ev = (o: any) => ({ id: 'e', project_id: 'prj_1', intent_id: 'i', status: 'queued', approval_state: 'pending', summary: 's', evidence_link: null, ...o });

describe('current-work · CurrentWorkProjection read route (flag-gated, inert)', () => {
  it('is inert (404 FEATURE_DISABLED) when the flag is off/absent', async () => {
    const res = await app([], undefined).request('/current-work');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('FEATURE_DISABLED');
  });

  it('projects a single pending item as the focus with a Review-now action', async () => {
    const res = await app([ev({ id: 'e1', status: 'needs_review', summary: 'Approve TAS section' })], 'true').request('/current-work');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.schema_id).toBe('xlooop.current_work_projection.v2');
    expect(b.projection_version).toBe(2);
    expect(b.focus.state).toBe('needs_review');
    expect(b.focus.event_id).toBe('e1');
    expect(b.focus.primary_action.code).toBe('review_result');
    expect(b.focus.focus_id).toBe('e1');
    expect(b.focus.object_type).toBe('event');
    expect(b.focus.target).toEqual({ type: 'event', id: 'e1', label: 'Approve TAS section' });
    expect(b.counts.needs_you).toBe(1);
  });

  it('projects N pending as an Open-queue action', async () => {
    const res = await app([ev({ id: 'e1', status: 'needs_review' }), ev({ id: 'e2', status: 'needs_review' })], 'true').request('/current-work');
    const b = await res.json();
    expect(b.counts.needs_you).toBe(2);
    expect(b.focus.primary_action.code).toBe('open_queue');
  });

  it('projects blocked-only as a Resolve action', async () => {
    const res = await app([ev({ id: 'b1', status: 'blocked', summary: 'Course price login-gated' })], 'true').request('/current-work');
    const b = await res.json();
    expect(b.focus.state).toBe('blocked');
    expect(b.focus.primary_action.code).toBe('resolve_blocker');
    expect(b.counts.blocked).toBe(1);
  });

  it('projects the all-clear state with no primary action', async () => {
    const res = await app([ev({ status: 'completed' })], 'true').request('/current-work');
    const b = await res.json();
    expect(b.focus.state).toBe('all_clear');
    expect(b.focus.primary_action).toBeNull();
    expect(b.counts.done).toBe(1);
    expect(b.counts.done_pct).toBe(100);
  });

  it('is customer-safe: evidence is a count, envelope carries data_class + allowed_actions', async () => {
    const res = await app([ev({ status: 'needs_review', evidence_link: 'x' })], 'true').request('/current-work');
    const b = await res.json();
    expect(typeof b.evidence_count).toBe('number');
    expect(b.evidence_count).toBe(1);
    expect(b.data_class).toBe('live');
    expect(Array.isArray(b.allowed_actions)).toBe(true);
    // never leaks evidence ids
    expect(JSON.stringify(b)).not.toMatch(/evidence_ref_ids|evidence_link/);
    expect(b.receipt_count).toBeNull();
    expect(b.receipt_count_status).toBe('unobservable_until_execution_receipt_read_is_wired');
  });
});
