import { describe, expect, it } from 'vitest';
import type { Sql } from '../db/client';
import {
  createPlanEntityWithAuthorityRow,
  deletePlanEntityWithAuthorityRow,
  updatePlanEntityWithAuthorityRow,
} from '../dal/plan-command-operations';

interface DeferredQuery extends PromiseLike<unknown[]> {
  text: string;
  values: unknown[];
}

function authorityBody(operation: 'create' | 'update' | 'delete') {
  return {
    entity: operation === 'delete' ? null : { id: 'ple_result' },
    deleted: operation === 'delete' ? { id: 'ple_result', updated_at: '2026-08-02T00:00:00.000Z' } : null,
    plan_entity_id: 'ple_result',
    plan_revision_id: `plan:${operation}:ple_result:2026-08-02T00:00:00.000Z`,
    operation,
    receipt_id: `plan:${operation}:ple_result:evt_result`,
    operation_event_id: 'evt_result',
    audit_event_id: '1',
    projection_outbox_id: 'out_result',
    read_model_watermark: '2026-08-02T00:00:00.000Z',
    replayed: false,
  };
}

function scriptedSql(
  digest: string,
  body: ReturnType<typeof authorityBody>,
  statements: string[],
  options: { replayDigest?: string; complete?: boolean } = {},
): Sql {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? '';
    values.forEach((_, index) => { text += `$${index + 1}${strings[index + 1] ?? ''}`; });
    const query = { text, values } as DeferredQuery;
    query.then = (resolve) => {
      statements.push(text);
      return Promise.resolve([]).then(resolve);
    };
    return query;
  }) as unknown as Sql & { transaction: (queries: readonly DeferredQuery[]) => Promise<unknown[][]> };
  tag.transaction = async (queries) => queries.map((query) => {
    statements.push(query.text);
    if (/UPDATE idempotency_keys replay\s+SET response_status/.test(query.text)) {
      return options.complete === false ? [] : [{ response_body: body }];
    }
    if (/SELECT request_sha256, response_status, response_body/.test(query.text)) {
      return [{
        request_sha256: options.replayDigest ?? digest,
        response_status: options.complete === false ? null : 201,
        response_body: options.complete === false ? null : body,
      }];
    }
    return [{}];
  });
  return tag;
}

const target = {
  id: 'ple_result',
  workspace_id: 'ws_1',
  scope_id: 'proj_1',
  scope_type: 'project',
  parent_id: null,
  position: 1,
  updated_at: '2026-08-01T00:00:00.000Z',
};

describe('plan authority commands', () => {
  it('persists create, event, audit, outbox, replay response, and authority assertion in one transaction', async () => {
    const digest = 'a'.repeat(64);
    const statements: string[] = [];
    const body = authorityBody('create');
    const receipt = await createPlanEntityWithAuthorityRow(
      scriptedSql(digest, body, statements),
      { workspace_id: 'ws_1', scope_id: 'proj_1', scope_type: 'project', kind: 'goal', title: 'Pilot goal' },
      'user_1',
      { key: 'plan-create-1', request_sha256: digest, route: 'POST /api/v1/plan/entity' },
    );
    expect(receipt).toEqual(body);
    expect(statements.join('\n')).toContain("'authority_strict'");
    expect(statements.join('\n')).toContain('INSERT INTO plan_entities');
    expect(statements.join('\n')).toContain('INSERT INTO operation_events');
    expect(statements.join('\n')).toContain('INSERT INTO audit_logs');
    expect(statements.join('\n')).toContain('INSERT INTO projection_outbox');
    expect(statements.join('\n')).toContain('xlooop_assert_authority_complete');
    expect(statements.at(-1)).toContain('SELECT request_sha256, response_status, response_body');
  });

  it('binds updates to workspace and prior revision, then re-packs within the same transaction', async () => {
    const digest = 'b'.repeat(64);
    const statements: string[] = [];
    await updatePlanEntityWithAuthorityRow(
      scriptedSql(digest, authorityBody('update'), statements),
      target,
      { position: 0 },
      'user_1',
      { key: 'plan-update-1', request_sha256: digest, route: 'PATCH /api/v1/plan/entity/ple_result' },
    );
    const joined = statements.join('\n');
    expect(joined).toContain('entity.workspace_id =');
    expect(joined).toContain('entity.updated_at =');
    expect(joined).toContain('pg_advisory_xact_lock');
    expect(joined).toContain('WITH RECURSIVE descendants');
    expect(joined).toContain('ROW_NUMBER() OVER');
    expect(joined).toContain(`position - $`);
  });

  it('soft-deletes and re-packs before recording durable authority', async () => {
    const digest = 'c'.repeat(64);
    const statements: string[] = [];
    const receipt = await deletePlanEntityWithAuthorityRow(
      scriptedSql(digest, authorityBody('delete'), statements),
      target,
      'user_1',
      { key: 'plan-delete-1', request_sha256: digest, route: 'DELETE /api/v1/plan/entity/ple_result' },
    );
    expect(receipt.deleted?.id).toBe('ple_result');
    expect(statements.join('\n')).toContain('SET deleted_at =');
    expect(statements.join('\n')).toContain('INSERT INTO audit_logs');
  });

  it('rejects a reused key whose request digest changed', async () => {
    const digest = 'd'.repeat(64);
    await expect(createPlanEntityWithAuthorityRow(
      scriptedSql(digest, authorityBody('create'), [], { replayDigest: 'e'.repeat(64) }),
      { workspace_id: 'ws_1', kind: 'goal', title: 'Changed request' },
      'user_1',
      { key: 'plan-create-2', request_sha256: digest, route: 'POST /api/v1/plan/entity' },
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
  });

  it('cleans an incomplete claim and refuses customer success', async () => {
    const digest = 'f'.repeat(64);
    const statements: string[] = [];
    await expect(createPlanEntityWithAuthorityRow(
      scriptedSql(digest, authorityBody('create'), statements, { complete: false }),
      { workspace_id: 'ws_1', kind: 'goal', title: 'Incomplete' },
      'user_1',
      { key: 'plan-create-3', request_sha256: digest, route: 'POST /api/v1/plan/entity' },
    )).rejects.toMatchObject({ code: 'PLAN_ATOMICITY_FAILED', status: 409 });
    expect(statements.at(-1)).toContain('DELETE FROM idempotency_keys');
  });

  it('maps a failed authority assertion to a stable refreshable conflict', async () => {
    const digest = '1'.repeat(64);
    const sql = scriptedSql(digest, authorityBody('update'), []);
    (sql as Sql & { transaction: () => Promise<never> }).transaction = async () => {
      throw { code: '23514', message: 'xlooop authority incomplete: plan_entity_update' };
    };
    await expect(updatePlanEntityWithAuthorityRow(
      sql,
      target,
      { parent_id: 'ple_descendant' },
      'user_1',
      { key: 'plan-cycle-1', request_sha256: digest, route: 'PATCH /api/v1/plan/entity/ple_result' },
    )).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });
});
