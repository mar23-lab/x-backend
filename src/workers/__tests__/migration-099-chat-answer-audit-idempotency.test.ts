import { describe, expect, it } from 'vitest';
import migration from '../db/migrations/099_chat_answer_audit_idempotency.sql?raw';

describe('migration 099 customer chat answer audit idempotency', () => {
  it('creates one tenant- and actor-scoped partial identity without storing conversation content', () => {
    expect(migration).toContain('audit_logs_customer_chat_answer_key');
    expect(migration).toContain('workspace_id, actor_user_id, action, target_type, target_id');
    expect(migration).toContain("action = 'customer_chat_answer'");
    expect(migration).toContain("target_type = 'session'");
    expect(migration).not.toMatch(/ADD COLUMN\s+(prompt|answer_body|response_body|customer_content)/i);
  });

  it('blocks duplicates before a non-blocking concurrent index build and records version 99', () => {
    expect(migration).toContain('HAVING count(*) > 1');
    expect(migration).toContain('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(migration).not.toMatch(/\bBEGIN\s*;/i);
    expect(migration).toMatch(/VALUES\s*\(\s*99,/);
    expect(migration).toContain('ON CONFLICT (version) DO NOTHING');
  });
});
