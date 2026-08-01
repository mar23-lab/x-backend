import { describe, expect, it } from 'vitest';
import migration from '../db/migrations/093_strict_idempotency_and_atomic_projects.sql?raw';

describe('migration 093 strict idempotency contract', () => {
  it('extends the existing idempotency store without creating a competing aggregate', () => {
    expect(migration).toContain('ALTER TABLE idempotency_keys');
    expect(migration).not.toMatch(/CREATE TABLE\s+(strict_|authority_)?idempotency/i);
    expect(migration).toContain("mode TEXT NOT NULL DEFAULT 'ordinary_retry_guard'");
    expect(migration).toContain('actor_user_id TEXT');
    expect(migration).toContain('request_sha256 TEXT');
  });

  it('separates ordinary and strict uniqueness and binds strict requests to a digest', () => {
    expect(migration).toContain('idempotency_keys_ordinary_key');
    expect(migration).toContain("WHERE mode = 'ordinary_retry_guard'");
    expect(migration).toContain('idempotency_keys_authority_key');
    expect(migration).toContain('(workspace_id, actor_user_id, route, idempotency_key)');
    expect(migration).toContain("WHERE mode = 'authority_strict'");
    expect(migration).toContain("request_sha256 ~ '^[a-f0-9]{64}$'");
  });

  it('records schema version 93 exactly once', () => {
    expect(migration).toContain('WHERE version = 93');
    expect(migration).toMatch(/VALUES\s*\(\s*93,\s*'Authority-strict idempotency mode/);
  });

  it('installs a transaction-failing authority assertion', () => {
    expect(migration).toContain('xlooop_assert_authority_complete');
    expect(migration).toContain("RAISE EXCEPTION 'xlooop authority incomplete: %'");
    expect(migration).toContain("USING ERRCODE = '23514'");
  });
});
