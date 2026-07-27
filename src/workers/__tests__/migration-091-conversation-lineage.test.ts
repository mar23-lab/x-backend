import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../db/migrations/091_conversation_interaction_lineage.sql', import.meta.url),
  'utf8',
);

describe('migration 091 conversation lineage contract', () => {
  it('extends the existing chat and intake aggregates without creating a competing store', () => {
    expect(migration).toContain('ALTER TABLE intake_resolutions');
    expect(migration).toContain('ALTER TABLE governed_execution_receipts');
    expect(migration).toContain('ALTER TABLE chat_messages');
    expect(migration).not.toMatch(/CREATE TABLE\s+(conversation|chat_)/i);
  });

  it('defines interaction idempotency and all governed execution authority references', () => {
    for (const required of [
      'interaction_id',
      'intent_id',
      'operation_event_id',
      'audit_event_id',
      'projection_outbox_id',
      'conversation_message_id',
      'closing_attestation_id',
    ]) {
      expect(migration).toContain(required);
    }
    expect(migration).toContain('UNIQUE INDEX IF NOT EXISTS chat_messages_interaction_entry_key');
    expect(migration).toContain('UNIQUE INDEX IF NOT EXISTS governed_execution_receipts_interaction');
    expect(migration).toContain("VALUES (\n      91,");
    expect(migration).toMatch(
      /VALUES\s*\(\s*91,\s*'Additive project-scoped conversation interaction lineage, exactly-once entry identity, and governed execution authority references',\s*now\(\)\s*\)/,
    );
  });
});
