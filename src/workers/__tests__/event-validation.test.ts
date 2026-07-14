// event-validation.test.ts — locks the shared intake-validation SSOT (P4 · 260629).
// Guards VALID_STATUSES + VALID_SOURCE_TOOLS that events.ts + activity-webhook.ts now both import. The
// canonical source-tool set INCLUDES folder/gmail/outlook — which activity-webhook's stale duplicate
// previously rejected (the drift this consolidation fixed); this test prevents that drift from recurring.

import { describe, it, expect } from 'vitest';
import { VALID_STATUSES, VALID_SOURCE_TOOLS } from '../lib/event-validation';

describe('event-validation SSOT', () => {
  it('accepts the canonical event statuses + rejects unknown', () => {
    for (const s of ['queued', 'running', 'blocked', 'needs_review', 'completed', 'failed', 'approved', 'rejected', 'archived']) {
      expect(VALID_STATUSES.has(s as never)).toBe(true);
    }
    expect(VALID_STATUSES.has('bogus' as never)).toBe(false);
  });

  it('source tools include the previously-drifted folder/gmail/outlook (activity-webhook drift fix)', () => {
    for (const t of ['codex', 'claude', 'harness', 'mbp', 'xlooop', 'operator',
      'github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive', 'folder', 'gmail', 'outlook']) {
      expect(VALID_SOURCE_TOOLS.has(t as never)).toBe(true);
    }
    expect(VALID_SOURCE_TOOLS.has('bogus' as never)).toBe(false);
  });
});
