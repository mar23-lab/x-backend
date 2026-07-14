// actor-lineage.ts · A-W4/P6 (260707) · principal + instrument actor lineage — the single source of truth.
//
// THE DOCTRINE (matches the new UI's actor model verbatim): when AI acts under a human's authority, the
// audit record carries PRINCIPAL + INSTRUMENT — "Claude · acting for Andrey", never just "by Andrey".
// operation_events already carries the INSTRUMENT id (`agent_id`, ≈ the UI's `actor`); migration 050 adds
// WHO AUTHORIZED it (`authorized_by_user_id`), WHAT KIND of instrument acted (`instrument_kind`), UNDER
// WHAT AUTHORITY (`authority_source`), and the HTTP correlation (`request_id`).
//
// VOCABULARY IS UI-ALIGNED AND FROZEN (verify:principal-instrument-lineage pins this file to the migration
// CHECK): instrument kinds are the new UI's ACTOR_KIND enum — human | agent | system | external. An API
// token is NOT an actor kind (it is an authority_source: 'token_scope'); cron/engine maps to 'system'.
// Full design: docs/governance/PRINCIPAL_INSTRUMENT_LINEAGE.md.

import type { AuthContext } from '../dal/types/auth';

/** The new UI's ACTOR_KIND enum, verbatim (lowercase). Frozen against migration 050's CHECK. */
export const INSTRUMENT_KINDS = ['human', 'agent', 'system', 'external'] as const;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

/** Under what authority the write happened. */
export const AUTHORITY_SOURCES = [
  'role',              // workspace role (owner/operator) permitted it
  'explicit_approval', // a recorded approval/sign-off authorized it
  'token_scope',       // a scoped API token's grant (service principal)
  'system_policy',     // scheduled/system action under standing platform policy
  'operator_identity', // MBP platform-operator identity overlay
] as const;
export type AuthoritySource = (typeof AUTHORITY_SOURCES)[number];

export interface ActorLineage {
  authorized_by_user_id: string | null; // the human principal (null only for pure system_policy writes)
  instrument_kind: InstrumentKind;
  authority_source: AuthoritySource;
}

/**
 * Derive the principal/instrument lineage for a write from the request's AuthContext. Pure — no I/O.
 *
 * Defaults: a Clerk-authenticated human acting directly is their own principal AND instrument ('human',
 * authority 'role'). A service-principal token write records the token's CREATING context as principal
 * where the caller supplies it; the instrument defaults to 'agent' (a connected AI/tool acting through the
 * scoped token) under 'token_scope'. Pass `instrument_kind: 'system'` for engine/cron-emitted events.
 */
export function lineageFor(
  auth: Pick<AuthContext, 'user_id' | 'role' | 'service_principal' | 'auth_method'>,
  overrides: Partial<Pick<ActorLineage, 'instrument_kind' | 'authority_source'>> = {},
): ActorLineage {
  if (auth.service_principal) {
    return {
      authorized_by_user_id: auth.user_id || null, // token rows resolve to the minting/bound identity
      instrument_kind: overrides.instrument_kind ?? 'agent',
      authority_source: overrides.authority_source ?? 'token_scope',
    };
  }
  return {
    authorized_by_user_id: auth.user_id || null,
    instrument_kind: overrides.instrument_kind ?? 'human',
    authority_source: overrides.authority_source ?? 'role',
  };
}

/** Lineage for a scheduled/system write with no request principal (standing platform policy). */
export function systemLineage(): ActorLineage {
  return { authorized_by_user_id: null, instrument_kind: 'system', authority_source: 'system_policy' };
}
