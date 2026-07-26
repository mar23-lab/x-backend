import { describe, expect, it } from 'vitest';
import { insertDocumentWithAuthorityRow, updateDocumentAdmissibilityWithAuthorityRow } from '../dal/document-store';
import { markUserSourceSyncRow } from '../dal/source-store';

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

describe('customer authority writes are fail-closed', () => {
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
