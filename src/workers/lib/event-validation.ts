// event-validation.ts — shared intake-validation SSOT (P4 · single-intake program, 260629).
//
// VALID_STATUSES + VALID_SOURCE_TOOLS were duplicated in events.ts + activity-webhook.ts — and the copies
// DRIFTED: activity-webhook's source-tool allowlist went STALE (missing folder/gmail/outlook that events.ts,
// the migration CHECK constraints, and the SourceTool union already accept), so the webhook wrongly REJECTED
// those valid sources. Consolidating here dedups AND fixes that drift (the canonical set from events.ts) —
// the operator's "single intake format + consolidate duplicates" directive, with the dedup surfacing a real bug.
import type { EventStatus, SourceTool } from '../dal/types';

export const VALID_STATUSES: ReadonlySet<EventStatus> = new Set([
  'queued', 'running', 'blocked', 'needs_review',
  'completed', 'failed', 'approved', 'rejected', 'archived',
]);

export const VALID_SOURCE_TOOLS: ReadonlySet<SourceTool> = new Set([
  'codex', 'claude', 'harness', 'mbp', 'xlooop', 'operator',
  // Clerk OAuth source connectors — must match migration 008_user_source_connections.sql CHECK + the
  // SourceTool union in src/workers/dal/types.ts:
  'github', 'google_drive', 'dropbox', 'gitlab', 'microsoft_onedrive',
  // reflection-only folder connector (migration 026 extends the source_tool CHECK):
  'folder',
  // picker-provider ingestion translators (migrations 039/040 extend both CHECKs):
  'gmail', 'outlook',
]);
