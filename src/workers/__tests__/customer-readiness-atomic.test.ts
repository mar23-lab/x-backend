import { describe, expect, it } from 'vitest';
import { saveWorkspaceReadinessAssessmentRow } from '../dal/customer-readiness-store';
import type { Sql } from '../db/client';

const INPUT = {
  workspace_id: 'ws_1',
  user_id: 'user_1',
  client_request_id: 'onboarding-1',
  request_digest: 'a'.repeat(64),
  email: 'customer@example.com',
  account_type: 'company' as const,
  readiness_answers: { focus_90d: 'ship safely' },
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rdy_1',
    access_request_id: 'req_1',
    user_id: 'user_1',
    workspace_id: 'ws_1',
    email: 'customer@example.com',
    account_type: 'company',
    also_personal_space: false,
    company_name: null,
    domain: null,
    country: null,
    deep_level: null,
    readiness_answers: { focus_90d: 'ship safely' },
    deep_check: null,
    enrichment: null,
    consent: {},
    source: 'inapp-readiness-profile',
    metadata: {},
    created_at: '2026-07-24T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:01.000Z',
    readiness_revision_id: 'readiness:rdy_1:audit_1',
    audit_event_id: 'audit_1',
    replayed: false,
    request_digest: 'a'.repeat(64),
    ...overrides,
  };
}

function sqlReturning(rows: unknown[]) {
  let statement = '';
  let calls = 0;
  const sql = ((strings: TemplateStringsArray) => {
    calls += 1;
    statement = strings.join('?');
    return Promise.resolve(rows);
  }) as unknown as Sql;
  return {
    sql,
    statement: () => statement,
    calls: () => calls,
  };
}

describe('saveWorkspaceReadinessAssessmentRow', () => {
  it('uses one fail-closed statement for lock, write, linkage, audit, and receipt', async () => {
    const capture = sqlReturning([row()]);
    const result = await saveWorkspaceReadinessAssessmentRow(capture.sql, INPUT);

    expect(result.readiness_revision_id).toBe('readiness:rdy_1:audit_1');
    expect(capture.calls()).toBe(1);
    expect(capture.statement()).toContain('pg_advisory_xact_lock');
    expect(capture.statement()).toContain('prior_receipt AS MATERIALIZED');
    expect(capture.statement()).toContain('readiness_written AS');
    expect(capture.statement()).toContain('request_linked AS');
    expect(capture.statement()).toContain('audit_written AS');
    expect(capture.statement()).toContain('FROM readiness_written r');
    expect(capture.statement()).toContain('JOIN audit_written a ON TRUE');
    expect(capture.statement()).toContain('JOIN readiness_assessments r');
  });

  it('cannot report success when no readiness/audit receipt row is returned', async () => {
    const capture = sqlReturning([]);
    await expect(saveWorkspaceReadinessAssessmentRow(capture.sql, INPUT)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  });

  it('rejects an idempotency-key replay with a different request digest', async () => {
    const capture = sqlReturning([row({
      replayed: true,
      request_digest: 'b'.repeat(64),
    })]);
    await expect(saveWorkspaceReadinessAssessmentRow(capture.sql, INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('returns the original receipt for an exact replay', async () => {
    const capture = sqlReturning([row({ replayed: true })]);
    await expect(saveWorkspaceReadinessAssessmentRow(capture.sql, INPUT)).resolves.toMatchObject({
      replayed: true,
      audit_event_id: 'audit_1',
      readiness_revision_id: 'readiness:rdy_1:audit_1',
    });
  });
});
