import { describe, expect, it } from 'vitest';
import { insertDocumentWithAuthorityRow, updateDocumentAdmissibilityWithAuthorityRow } from '../dal/document-store';
import { markUserSourceSyncRow } from '../dal/source-store';
import { recordCustomerConsentAckRow, revokeCustomerAuthorityRow } from '../dal/customer-authority-store';

function capturingSql(rows: Array<Record<string, unknown>>) {
  let statement = '';
  const sql = ((parts: TemplateStringsArray) => {
    statement = parts.join('?');
    return Promise.resolve(rows);
  }) as never;
  return { sql, statement: () => statement };
}

const documentInput = {
  id: 'doc_1',
  workspace_id: 'ws_1',
  project_id: null,
  filename: 'proof.txt',
  content_type: 'text/plain',
  size_bytes: 5,
  content_base64: 'cHJvb2Y=',
  extracted_text: 'proof',
  uploaded_by: 'usr_1',
  status: 'ingested',
  content_hash: 'a'.repeat(64),
  version: 1,
  supersedes_id: null,
};

const authorityRow = {
  id: 'auth_1',
  workspace_id: 'ws_1',
  access_request_id: null,
  operator_approved_at: null,
  operator_approved_by: null,
  allowed_modes: [],
  allowed_apps: [],
  consent_acked_at: '2026-07-30T00:00:00.000Z',
  consent_acked_by: 'usr_1',
  full_name_typed: 'Test Owner',
  scopes_confirmed: {},
  consent_version: 'authority_v1',
  ip_address: null,
  user_agent: null,
  revoked_at: null,
  revoked_by: null,
  revoked_reason: null,
  metadata: {},
  created_at: '2026-07-30T00:00:00.000Z',
  updated_at: '2026-07-30T00:00:00.000Z',
  operation_event_id: 'evt_authority_1',
  audit_event_id: 'audit_authority_1',
  projection_outbox_id: 'outbox_authority_1',
  read_model_watermark: '2026-07-30T00:00:00.000Z',
};

function authorityResponse(kind: 'consent' | 'revoke' = 'consent') {
  const consent = { ...authorityRow, revoked_at: kind === 'revoke' ? '2026-07-30T01:00:00.000Z' : null };
  return {
    response_body: {
      consent,
      authority_receipt_id: `customer-authority-${kind}:auth_1:audit_authority_1`,
      operation_event_id: 'evt_authority_1',
      audit_event_id: 'audit_authority_1',
      projection_outbox_id: 'outbox_authority_1',
      read_model_watermark: '2026-07-30T00:00:00.000Z',
      replayed: false,
    },
  };
}

const strictConsent = {
  idempotency_key: 'authority-test-key',
  request_sha256: 'a'.repeat(64),
  idempotency_route: 'POST /api/v1/customer/authority-consent' as const,
};

const strictRevoke = {
  idempotency_key: 'authority-revoke-test-key',
  request_sha256: 'b'.repeat(64),
  idempotency_route: 'POST /api/v1/customer/authority-consent/revoke' as const,
};

describe('customer authority writes are fail-closed', () => {
  it('customer consent requires consent, event, audit, and outbox in its final authority result', async () => {
    const db = capturingSql([authorityResponse()]);
    const write = await recordCustomerConsentAckRow(db.sql, {
      workspace_id: 'ws_1',
      user_id: 'usr_1',
      full_name_typed: 'Test Owner',
      operation_event_id: 'evt_authority_1',
      projection_outbox_id: 'outbox_authority_1',
      request_id: 'req_1',
      ...strictConsent,
    });

    expect(write.authority_receipt_id).toBe('customer-authority-consent:auth_1:audit_authority_1');
    expect(write.operation_event_id).toBe('evt_authority_1');
    expect(write.audit_event_id).toBe('audit_authority_1');
    expect(write.projection_outbox_id).toBe('outbox_authority_1');
    expect(db.statement()).toMatch(
      /FROM consent_written\s+JOIN event_written ON TRUE\s+JOIN audit_written ON TRUE\s+JOIN outbox_written ON TRUE/s,
    );
    expect(db.statement()).toMatch(/mode,\s+response_status, response_body, completed_at/);
    // REGRESSION GUARD (260803). This previously asserted the presence of a `claim_finalized` CTE:
    //   UPDATE idempotency_keys ... FROM strict_claim WHERE idempotency_keys.id = strict_claim.id
    // which can NEVER match. Postgres data-modifying CTEs all read the snapshot taken at statement
    // start, so that UPDATE could not see the row its sibling INSERT had just created. It returned
    // 0 rows every time, the completeness assert raised 23514, and strict consent/revoke failed
    // 100% of the time against real Postgres — while this very test passed, because the mock `sql`
    // here has no snapshot semantics. So the assertion was pinning the broken shape in place.
    //
    // Inverted deliberately: assert the impossible construct is ABSENT. The claim is now written
    // once, already complete, and its correctness is proven where it can actually be proven —
    // intake-schema91-postgres against a real database.
    // Anchored to line-start so it matches a real statement and not the SQL comment that explains
    // why the construct was removed — the comment text is part of db.statement() too.
    expect(db.statement()).not.toMatch(/^\s*UPDATE idempotency_keys/m);
    // And it must be attempted UNCONDITIONALLY, or a repeat command never collides on the unique
    // index and the 23505 replay path silently stops working.
    expect(db.statement()).toMatch(/FROM \(SELECT 1\) AS always_claim\s+LEFT JOIN response_payload ON TRUE/s);
  });

  it('customer consent cannot issue a receipt when any authority CTE yields no row', async () => {
    const db = capturingSql([]);
    await expect(recordCustomerConsentAckRow(db.sql, {
      workspace_id: 'ws_1',
      user_id: 'usr_1',
      full_name_typed: 'Test Owner',
      operation_event_id: 'evt_authority_1',
      projection_outbox_id: 'outbox_authority_1',
      ...strictConsent,
    })).rejects.toMatchObject({ code: 'CUSTOMER_AUTHORITY_ATOMICITY_FAILED', status: 500 });
  });

  it('customer authority revoke requires target, event, audit, and outbox in its final authority result', async () => {
    const db = capturingSql([authorityResponse('revoke')]);
    const write = await revokeCustomerAuthorityRow(db.sql, {
      workspace_id: 'ws_1',
      revoked_by: 'usr_1',
      re_attest_name: 'Test Owner',
      operation_event_id: 'evt_authority_1',
      projection_outbox_id: 'outbox_authority_1',
      request_id: 'req_1',
      ...strictRevoke,
    });

    expect(write.authority_receipt_id).toBe('customer-authority-revoke:auth_1:audit_authority_1');
    expect(db.statement()).toMatch(
      /FROM consent_updated\s+JOIN event_written ON TRUE\s+JOIN audit_written ON TRUE\s+JOIN outbox_written ON TRUE/s,
    );
    // Same regression guard as the consent path — the never-matching same-statement UPDATE must not
    // return, and the claim must be attempted unconditionally so a revoke REPLAY still hits 23505.
    // Sourcing the claim straight FROM response_payload inserted zero rows on a replay (no active
    // consent to revoke), which turned a legitimate replay into a 404.
    // Anchored to line-start so it matches a real statement and not the SQL comment that explains
    // why the construct was removed — the comment text is part of db.statement() too.
    expect(db.statement()).not.toMatch(/^\s*UPDATE idempotency_keys/m);
    expect(db.statement()).toMatch(/FROM \(SELECT 1\) AS always_claim\s+LEFT JOIN response_payload ON TRUE/s);
  });

  it('customer authority revoke cannot issue a receipt when no active consent row is updated', async () => {
    const db = capturingSql([]);
    await expect(revokeCustomerAuthorityRow(db.sql, {
      workspace_id: 'ws_1',
      revoked_by: 'usr_1',
      operation_event_id: 'evt_authority_1',
      projection_outbox_id: 'outbox_authority_1',
      ...strictRevoke,
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('document upload requires event, audit, and projection rows in its final authority result', async () => {
    const db = capturingSql([{
      ...documentInput,
      uploaded_at: '2026-07-26T00:00:00.000Z',
      admissibility: 'approved',
      operation_event_id: 'evt_doc_1',
      audit_event_id: 'audit_doc_1',
      projection_outbox_id: 'outbox_doc_1',
    }]);

    const write = await insertDocumentWithAuthorityRow(db.sql, documentInput, {
      operation_event_id: 'evt_doc_1',
      projection_outbox_id: 'outbox_doc_1',
      request_id: 'req_1',
    });

    expect(write.receipt_id).toBe('document-upload:doc_1:audit_doc_1');
    expect(write.operation_event_id).toBe('evt_doc_1');
    expect(write.audit_event_id).toBe('audit_doc_1');
    expect(write.projection_outbox_id).toBe('outbox_doc_1');
    expect(db.statement()).toMatch(
      /FROM document_written\s+JOIN event_written ON TRUE\s+JOIN audit_written ON TRUE\s+JOIN outbox_written ON TRUE/s,
    );
  });

  it('document upload cannot issue a receipt when the final authority join yields zero rows', async () => {
    const db = capturingSql([]);
    await expect(insertDocumentWithAuthorityRow(db.sql, documentInput, {
      operation_event_id: 'evt_doc_1',
      projection_outbox_id: 'outbox_doc_1',
      request_id: 'req_1',
    })).rejects.toThrow('did not produce a complete receipt');
  });

  it('document admissibility requires the updated document, event, audit, and outbox in its final result', async () => {
    const db = capturingSql([{
      ...documentInput,
      uploaded_at: '2026-07-26T00:00:00.000Z',
      admissibility: 'excluded',
      operation_event_id: 'evt_adm_1',
      audit_event_id: 'audit_adm_1',
      projection_outbox_id: 'outbox_adm_1',
    }]);
    const write = await updateDocumentAdmissibilityWithAuthorityRow(
      db.sql,
      'ws_1',
      'doc_1',
      'excluded',
      {
        actor_user_id: 'usr_1',
        operation_event_id: 'evt_adm_1',
        projection_outbox_id: 'outbox_adm_1',
        request_id: 'req_1',
      },
    );

    expect(write?.receipt_id).toBe('document-admissibility:doc_1:audit_adm_1');
    expect(db.statement()).toMatch(
      /FROM document_updated\s+JOIN event_written ON TRUE\s+JOIN audit_written ON TRUE\s+JOIN outbox_written ON TRUE/s,
    );
  });

  it('document admissibility cannot issue a receipt when no document row is updated', async () => {
    const db = capturingSql([]);
    await expect(updateDocumentAdmissibilityWithAuthorityRow(
      db.sql,
      'ws_1',
      'missing_doc',
      'excluded',
      {
        actor_user_id: 'usr_1',
        operation_event_id: 'evt_adm_1',
        projection_outbox_id: 'outbox_adm_1',
        request_id: 'req_1',
      },
    )).resolves.toBeNull();
  });

  it('source sync requires source, event, audit, and projection rows in its final authority result', async () => {
    const db = capturingSql([{
      id: 'src_1',
      operation_event_id: 'evt_sync_1',
      audit_event_id: 'audit_sync_1',
      projection_outbox_id: 'outbox_sync_1',
    }]);

    const write = await markUserSourceSyncRow(
      db.sql,
      'usr_1',
      'src_1',
      { success: true },
      'ws_1',
      {
        operation_event_id: 'evt_sync_1',
        projection_outbox_id: 'outbox_sync_1',
        request_id: 'req_1',
        source_tool: 'gmail',
        emitted_events: [{
          source_event_id: `gmail:${'b'.repeat(64)}`,
          operation_event_id: 'evt_gmail_1',
          source_ref_hash: 'b'.repeat(64),
        }],
      },
    );

    expect(write.source_sync_receipt_id).toBe('source-sync:src_1:success:audit_sync_1');
    expect(write.operation_event_id).toBe('evt_sync_1');
    expect(write.audit_event_id).toBe('audit_sync_1');
    expect(write.projection_outbox_id).toBe('outbox_sync_1');
    expect(db.statement()).toMatch(
      /FROM source_updated\s+JOIN event_written ON TRUE\s+JOIN audit_written ON TRUE\s+JOIN outbox_written ON TRUE/s,
    );
  });

  it('source sync cannot issue a receipt when the final authority join yields zero rows', async () => {
    const db = capturingSql([]);
    await expect(markUserSourceSyncRow(
      db.sql,
      'usr_1',
      'src_1',
      { success: true },
      'ws_1',
      {
        operation_event_id: 'evt_sync_1',
        projection_outbox_id: 'outbox_sync_1',
        request_id: 'req_1',
        source_tool: 'gmail',
      },
    )).rejects.toMatchObject({ code: 'SOURCE_SYNC_AUTHORITY_MISSING', status: 409 });
  });
});
