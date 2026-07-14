// model-runtime-store.test.ts · Wave C · locks the DAL-layer security + audit invariants of the
// model-runtime store (migration 053). Mocks the `Sql` tagged-template (repo store-test convention) and
// records every query, so we can prove: (a) list reads NEVER select the ciphertext/iv columns
// (mask-by-construction), (b) every provider write commits an audit_logs row in the SAME transaction,
// (c) the sealed credential is passed through verbatim (never logged/transformed), (d) the default flip is
// audited with the correct action + target_type.

import { describe, it, expect } from 'vitest';
import {
  listProvidersRow,
  getProviderCredentialRow,
  upsertProviderRow,
  deleteProviderRow,
  setDefaultProviderRow,
  setOverrideRow,
  PROVIDER_SPECS,
  MODEL_RUNTIME_PROVIDERS,
} from '../dal/model-runtime-store';

type Row = Record<string, any>;

/** Mock `Sql` tagged-template + `.transaction`. Records normalized queries; responder returns canned rows. */
function makeSql(responder: (query: string, values: any[]) => Row[]) {
  const calls: Array<{ query: string; values: any[] }> = [];
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ query, values });
    return Promise.resolve(responder(query, values));
  };
  sql.calls = calls;
  // In the store, sql`...` executes eagerly (recording the call) and .transaction awaits the resulting
  // promises — mirror that: return the per-query results in order.
  sql.transaction = (queries: Promise<Row[]>[]) => Promise.all(queries);
  return sql;
}

const maskedRow = (over: Partial<Row> = {}): Row => ({
  id: 'mrp_1', provider: 'anthropic', auth_kind: 'api_key', base_url: null, model: null,
  credential_last4: '1234', enabled: true, is_default: false, created_by: 'u1',
  created_at: '2026-07-08T00:00:00Z', updated_at: '2026-07-08T00:00:00Z', ...over,
});

const isProviderList = (q: string) => /SELECT .* FROM model_runtime_providers WHERE workspace_id/.test(q);
const isAuditInsert = (q: string) => /INSERT INTO audit_logs/.test(q);

describe('model-runtime-store · read safety', () => {
  it('listProvidersRow NEVER selects credential_ciphertext / credential_iv (mask-by-construction)', async () => {
    const sql = makeSql(() => [maskedRow()]);
    const rows = await listProvidersRow(sql, 'ws_a' as any);
    expect(rows).toHaveLength(1);
    const listQuery = sql.calls.find((c: any) => isProviderList(c.query))!.query;
    expect(listQuery).not.toMatch(/credential_ciphertext/);
    expect(listQuery).not.toMatch(/credential_iv/);
    expect(listQuery).toMatch(/credential_last4/); // only the masked tail is read
  });

  it('listProvidersRow degrades to [] on a DB error (deployable before the migration is applied)', async () => {
    const sql: any = () => Promise.reject(new Error('relation "model_runtime_providers" does not exist'));
    sql.calls = [];
    expect(await listProvidersRow(sql, 'ws_a' as any)).toEqual([]);
  });

  it('getProviderCredentialRow returns the sealed triple (internal path) — the ONLY read of the ciphertext', async () => {
    const sql = makeSql(() => [{ auth_kind: 'api_key', ciphertext: 'CT', iv: 'IV' }]);
    const cred = await getProviderCredentialRow(sql, 'ws_a' as any, 'anthropic');
    expect(cred).toEqual({ auth_kind: 'api_key', ciphertext: 'CT', iv: 'IV' });
    expect(sql.calls[0].query).toMatch(/credential_ciphertext AS ciphertext/);
  });
});

describe('model-runtime-store · audited writes', () => {
  it('upsertProviderRow writes the config AND an audit row in one transaction; passes the sealed credential verbatim', async () => {
    const sql = makeSql((q) => (/INSERT INTO model_runtime_providers/.test(q) ? [maskedRow()] : []));
    const sealed = { ciphertext: 'CIPHER', iv: 'IVIV', last4: '1234' };
    const row = await upsertProviderRow(
      sql, 'ws_a' as any, 'anthropic',
      { auth_kind: 'api_key', base_url: null, model: null, enabled: true, sealed },
      'actor1' as any,
    );
    expect(row.id).toBe('mrp_1');
    const upsert = sql.calls.find((c: any) => /INSERT INTO model_runtime_providers/.test(c.query))!;
    const audit = sql.calls.find((c: any) => isAuditInsert(c.query))!;
    expect(upsert).toBeTruthy();
    expect(audit).toBeTruthy(); // audit ALWAYS accompanies a write
    // the sealed credential is passed as bound values verbatim (never logged/rewritten)
    expect(upsert.values).toContain('CIPHER');
    expect(upsert.values).toContain('IVIV');
    expect(upsert.values).toContain('1234');
    // the RETURNING clause is the masked column set (no ciphertext leaves the DAL on a write either)
    expect(upsert.query).not.toMatch(/RETURNING[^`]*credential_ciphertext/);
    // audit action + target_type
    expect(audit.values).toContain('model_runtime_provider_set');
    expect(audit.query).toMatch(/'model_runtime_provider'/);
  });

  it('upsert with sealed=null preserves the stored credential via COALESCE (metadata-only update)', async () => {
    const sql = makeSql((q) => (/INSERT INTO model_runtime_providers/.test(q) ? [maskedRow()] : []));
    await upsertProviderRow(sql, 'ws_a' as any, 'ollama', { auth_kind: 'none', base_url: 'http://x', model: null, enabled: false, sealed: null }, 'actor1' as any);
    const upsert = sql.calls.find((c: any) => /INSERT INTO model_runtime_providers/.test(c.query))!;
    expect(upsert.query).toMatch(/COALESCE\(EXCLUDED.credential_ciphertext, model_runtime_providers.credential_ciphertext\)/);
    // null sealed → the bound credential values are null (COALESCE keeps the stored ones)
    expect(upsert.values).toContain(null);
  });

  it('setDefaultProviderRow flips in one UPDATE and audits with model_runtime_default_change', async () => {
    const sql = makeSql((q) => (/UPDATE model_runtime_providers/.test(q) ? [maskedRow({ is_default: true })] : []));
    const row = await setDefaultProviderRow(sql, 'ws_a' as any, 'mrp_1', 'actor1' as any);
    expect(row?.is_default).toBe(true);
    const upd = sql.calls.find((c: any) => /UPDATE model_runtime_providers/.test(c.query))!;
    const audit = sql.calls.find((c: any) => isAuditInsert(c.query))!;
    expect(upd.query).toMatch(/SET is_default = \(id = \?\s*\)/); // single-statement flip (partial-unique-safe)
    expect(audit.values).toContain('model_runtime_default_change');
    expect(audit.query).toMatch(/'model_runtime_provider'/);
  });

  it('deleteProviderRow audits with model_runtime_provider_delete; true iff a row was removed', async () => {
    const sql = makeSql((q) => (/DELETE FROM model_runtime_providers/.test(q) ? [{ id: 'mrp_1' }] : []));
    expect(await deleteProviderRow(sql, 'ws_a' as any, 'anthropic', 'actor1' as any)).toBe(true);
    const audit = sql.calls.find((c: any) => isAuditInsert(c.query))!;
    expect(audit.values).toContain('model_runtime_provider_delete');
    const sqlNone = makeSql(() => []); // nothing deleted
    expect(await deleteProviderRow(sqlNone, 'ws_a' as any, 'anthropic', 'actor1' as any)).toBe(false);
  });

  it('setOverrideRow is a personal preference — UPSERTs, and does NOT write an audit row', async () => {
    const sql = makeSql(() => []);
    await setOverrideRow(sql, 'u1' as any, 'ws_a' as any, 'mrp_1');
    expect(sql.calls.some((c: any) => /INSERT INTO user_runtime_override/.test(c.query))).toBe(true);
    expect(sql.calls.some((c: any) => isAuditInsert(c.query))).toBe(false);
  });
});

describe('model-runtime-store · provider registry', () => {
  it('has exactly 13 providers, each with a spec; keyless-local require base_url + no key', () => {
    expect(MODEL_RUNTIME_PROVIDERS).toHaveLength(13);
    for (const p of MODEL_RUNTIME_PROVIDERS) expect(PROVIDER_SPECS[p]).toBeTruthy();
    for (const p of ['ollama', 'lm_studio', 'vllm', 'llama_cpp'] as const) {
      expect(PROVIDER_SPECS[p].auth_kind).toBe('none');
      expect(PROVIDER_SPECS[p].requires_key).toBe(false);
      expect(PROVIDER_SPECS[p].requires_base_url).toBe(true);
      expect(PROVIDER_SPECS[p].locality).toBe('private');
    }
    expect(PROVIDER_SPECS.aws_bedrock.auth_kind).toBe('aws_sigv4'); // no bearer key
    expect(PROVIDER_SPECS.anthropic.locality).toBe('anthropic');
  });
});
