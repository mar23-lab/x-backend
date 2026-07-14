// translators/types.ts · R50.3c · 2026-05-28
//
// Shared types for the 5 per-provider translators under
// src/workers/sources/translators/*.ts. Each translator implements the same
// shape `runTranslator(input) → result` so R50.3d cron can dispatch
// uniformly across providers.

import type { ClerkOAuthAdapter } from '../../dal/clerk-oauth-adapter';
import type { DalAdapter } from '../../dal/DalAdapter';
import type { UserSourceConnection } from '../../dal/types';

/** Common input shape for every translator. */
export interface TranslatorInput {
  /** Clerk OAuth adapter (provides fresh access tokens). */
  adapter: ClerkOAuthAdapter;
  /** DAL adapter (writes operation_events + reads/updates user_source_connections). */
  dal: DalAdapter;
  /** The user_source_connections row being synced. */
  userSource: UserSourceConnection;
  /** ISO8601 cutoff · only fetch events occurred_at ≥ this. */
  since: string;
  /** Hard cap on events emitted per run (prevents runaway translators). */
  max_events?: number;
}

/** Common result shape. R50.3d cron aggregates these across providers. */
export interface TranslatorResult {
  /** How many events were emitted to operation_events. */
  events_emitted: number;
  /** How many events the contract-enforcer rejected. */
  events_rejected: number;
  /** API errors (rate-limit, auth, etc) encountered during this run. */
  errors: TranslatorError[];
  /** When this run completed. */
  completed_at: string;
}

export interface TranslatorError {
  code: string;
  message: string;
  upstream?: string; // e.g. 'github_api_429' or 'oauth_revoked'
}

/** Provider-name → translator-id (for R50.3d cron registry + smoke checks). */
export const TRANSLATOR_IDS = {
  github: 'r50.3c.github',
  google_drive: 'r50.3c.google_drive',
  dropbox: 'r50.3c.dropbox',
  gitlab: 'r50.3c.gitlab',
  microsoft_onedrive: 'r50.3c.microsoft_onedrive',
  gmail: 's5b.gmail',
  outlook: 's5b.outlook',
} as const;

/** Default `max_events` per single run; prevents one provider from saturating the cron tick. */
export const DEFAULT_MAX_EVENTS_PER_RUN = 100;
