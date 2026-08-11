import { describe, expect, it } from 'vitest';
import migration from '../db/migrations/101_connector_oauth_grants.sql?raw';

describe('migration 101 dedicated connector OAuth authority', () => {
  it('separates encrypted connector grants from identity accounts', () => {
    expect(migration).toContain('CREATE TABLE connector_oauth_grants');
    expect(migration).toContain('token_ciphertext');
    expect(migration).toContain('token_iv');
    expect(migration).toContain("authority_provider IN ('google')");
    expect(migration).not.toMatch(/clerk_external_account/i);
    expect(migration).not.toMatch(/access_token\s+TEXT/i);
    expect(migration).not.toMatch(/refresh_token\s+TEXT/i);
  });

  it('binds every source grant to the same tenant and user', () => {
    expect(migration).toContain('UNIQUE (id, workspace_id, user_id)');
    expect(migration).toContain('FOREIGN KEY (oauth_grant_id, workspace_id, user_id)');
    expect(migration).toContain('REFERENCES connector_oauth_grants (id, workspace_id, user_id)');
    expect(migration).toContain('ON DELETE RESTRICT');
  });

  it('separates tenant-scoped dedicated connections from legacy user authority', () => {
    expect(migration).toContain("legacy_uniqueness_definition <> 'UNIQUE (user_id, provider)'");
    expect(migration).toContain('migration 101 refuses unexpected user_source_connections_user_id_provider_key definition');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS user_source_connections_user_id_provider_key');
    expect(migration).toContain('user_source_connections_legacy_user_provider_key');
    expect(migration).toContain('WHERE oauth_grant_id IS NULL');
    expect(migration).toContain('user_source_connections_tenant_user_provider_key');
    expect(migration).toContain('ON user_source_connections (workspace_id, user_id, provider)');
    expect(migration).toContain('WHERE oauth_grant_id IS NOT NULL');
  });

  it('enforces one-time callback state and owner-only credential reads', () => {
    expect(migration).toContain('CREATE TABLE connector_oauth_state_nonces');
    expect(migration).toContain('consumed_at');
    expect(migration).toContain('ALTER TABLE connector_oauth_grants ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE connector_oauth_state_nonces ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON connector_oauth_grants FROM xlooop_app');
    expect(migration).toContain('REVOKE ALL ON connector_oauth_state_nonces FROM xlooop_app');
  });

  it('records schema head 101 idempotently', () => {
    expect(migration).toContain('workers_schema_version WHERE version = 101');
    expect(migration).toContain("VALUES (101, 'dedicated tenant connector OAuth grants and source binding', now())");
  });
});
