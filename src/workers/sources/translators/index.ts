// src/workers/sources/translators/index.ts · R50.3d
//
// Uniform per-provider translator registry. The /sync route (R50.3d slice 1)
// and the future R50.3d cron dispatch through getTranslator(provider) so every
// provider is invoked with the same `runTranslator(input) -> result` contract
// declared in translators/types.ts. Each translator pulls provider metadata and
// writes operation_events via the DAL internally; this module is pure dispatch.

import { runTranslator as runGithub } from './github';
import { runTranslator as runGoogleDrive } from './google_drive';
import { runTranslator as runDropbox } from './dropbox';
import { runTranslator as runGitlab } from './gitlab';
import { runTranslator as runMicrosoftOnedrive } from './microsoft_onedrive';
import { runTranslator as runGmail } from './gmail';
import { runTranslator as runOutlook } from './outlook';
import type { TranslatorInput, TranslatorResult } from './types';
import type { OAuthProvider } from '../../dal/types';

export type TranslatorFn = (input: TranslatorInput) => Promise<TranslatorResult>;

/** Provider -> translator. Every OAuthProvider has a registered translator. */
export const TRANSLATOR_REGISTRY: Record<OAuthProvider, TranslatorFn> = {
  github: runGithub,
  google_drive: runGoogleDrive,
  dropbox: runDropbox,
  gitlab: runGitlab,
  microsoft_onedrive: runMicrosoftOnedrive,
  gmail: runGmail,
  outlook: runOutlook,
};

/**
 * S-R3 (260629) · whether each provider's translator is verified against the REAL provider API (a live
 * smoke call), not just unit-tested against an author-authored mock of the API shape. A provider marked
 * `false` is DORMANT-UNVERIFIED: it MUST NOT be exposed in connector-registry (the connect UI) or enabled
 * until a real-API smoke is recorded — enforced by scripts/verify-translator-live-verification.mjs.
 * Exhaustive over OAuthProvider so a NEW provider must declare its status (it cannot ship silently unverified).
 */
export const TRANSLATOR_VERIFICATION: Record<OAuthProvider, boolean> = {
  github: true,             // R50.3c · verified against the live API
  google_drive: true,       // R50.3c
  dropbox: true,            // R50.3c
  gitlab: true,             // R50.3c
  microsoft_onedrive: true, // R50.3c
  gmail: true,              // 260630 · LIVE-VERIFICATION IN PROGRESS (operator-approved, Option A): exposed so the operator (codelooop23) connects their REAL mailbox; the connect → user_source_connections row → sync → real Gmail-metadata pull is being verified against the live API right now. REVERT to false if the translator does not pull real metadata. (was: false · unit-mock-only)
  outlook: false,           // S5b · unit-tested vs an authentic mock; NOT yet verified against live Microsoft Graph
};

/** Returns the translator fn for a provider, or null if unmapped. */
export function getTranslator(provider: OAuthProvider): TranslatorFn | null {
  return TRANSLATOR_REGISTRY[provider] ?? null;
}
