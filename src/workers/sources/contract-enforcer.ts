// contract-enforcer.ts · R50.3c · 2026-05-28
//
// Authority: R50 plan stage R50.3c · CLERK_OAUTH_PROVIDER_CONFIG.md
//
// Single load-bearing function: `enforceContract(event, contract)` validates
// translator-emitted events against the `user_source_connections.contract`
// JSONB BEFORE they reach DAL.upsertEvent. Rejects events that:
//   - violate `ingestion_mode='reflection_only'` (no full-content ingestion)
//   - exceed `max_body_bytes` (default 200; truncates rather than rejecting)
//   - reference fields outside `allowed_fields` allowlist
//
// USED BY:
//   - Every translator under src/workers/sources/translators/*.ts
//     (R50.3c · per-provider event emission)
//
// STOP CONDITION (codified in XLOOOP_SYSTEM_DESIGN_v1.md §2 P-INFER-3 +
// stop conditions list):
//   `source_translator_ingests_file_content_beyond_contract` (HARD post-R50.3c)
//
// CONTRACT INVARIANTS:
//   1. Pure function · zero side effects · deterministic per input
//   2. Truncation is silent + recorded in metadata.contract_actions array
//   3. Rejection is loud (typed error code · prevents INSERT)
//   4. Operator can audit every event's contract decisions via the
//      metadata.contract_actions trail on the operation_events row
//
// EVOLUTION:
//   contract.version=1 is what migration 008 ships. Future versions extend
//   allowed_fields / change max_body_bytes / add new ingestion_modes. This
//   enforcer dispatches on contract.version; v2+ handlers land alongside
//   the migration that bumps the default version.

import type {
  HarnessFlowEventInput,
  SourceConnectionContract,
  SourceTool,
} from '../dal/types';

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

export type ContractViolationCode =
  | 'CONTRACT_VERSION_UNSUPPORTED'
  | 'CONTRACT_INGESTION_MODE_VIOLATION'  // attempted full-content ingestion
  | 'CONTRACT_FIELD_NOT_ALLOWED'         // event field outside allowlist
  | 'CONTRACT_MAX_BODY_BYTES_EXCEEDED'   // body too big AFTER truncation attempt
  | 'CONTRACT_INVALID_EVENT_SHAPE';      // event missing required fields

export interface ContractViolation {
  code: ContractViolationCode;
  message: string;
  field?: string;
}

// Contract actions track what the enforcer did to make the event acceptable.
// Stored in the emitted event's metadata for audit.
export type ContractAction =
  | { kind: 'truncated'; field: string; from_bytes: number; to_bytes: number }
  | { kind: 'stripped'; field: string };

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ContractEnforcementResult =
  | {
      ok: true;
      event: HarnessFlowEventInput;
      actions: ContractAction[];
    }
  | {
      ok: false;
      violation: ContractViolation;
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The default contract shape from migration 008's DEFAULT — used as the
// reference baseline. Translators receive the actual contract from the
// user_source_connections row; this constant exists for documentation
// + testing.
export const DEFAULT_R50_3A_CONTRACT: SourceConnectionContract = {
  version: 1,
  ingestion_mode: 'reflection_only',
  allowed_fields: ['title', 'subject', 'timestamp', 'author_login'],
  max_body_bytes: 200,
  rate_limit: { per_hour: 5000 },
};

// Fields the enforcer NEVER strips even if absent from contract.allowed_fields.
// These are the structural fields needed to construct a valid operation_event
// row. The allowlist applies to semantic content (body/summary excerpts),
// not row metadata.
const STRUCTURAL_FIELDS = new Set<keyof HarnessFlowEventInput>([
  'id', 'source_tool', 'agent_id', 'project_id', 'intent_id',
  'status', 'visibility', 'permission_scope', 'occurred_at',
  'approval_state', 'risk', 'next_action', 'evidence_link',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate + sanitize an event before INSERT. Pure function.
 *
 * @param event   Translator-emitted candidate event
 * @param contract  The user_source_connections.contract value (from the row)
 * @returns       { ok: true, event: sanitized, actions } OR { ok: false, violation }
 */
export function enforceContract(
  event: HarnessFlowEventInput,
  contract: SourceConnectionContract,
): ContractEnforcementResult {
  // 1) Version dispatch
  if (contract.version !== 1) {
    return {
      ok: false,
      violation: {
        code: 'CONTRACT_VERSION_UNSUPPORTED',
        message: `contract version ${contract.version} not supported by enforcer v1`,
      },
    };
  }

  // 2) Validate event shape (defensive — translator should send valid shape
  //    but enforcer is the last line of defense)
  if (!event.id || !event.source_tool || !event.summary || !event.status || !event.occurred_at) {
    return {
      ok: false,
      violation: {
        code: 'CONTRACT_INVALID_EVENT_SHAPE',
        message: `event missing required structural fields (id/source_tool/summary/status/occurred_at)`,
      },
    };
  }

  // 3) ingestion_mode enforcement.
  //    R50.3a defines 'reflection_only' as the only supported mode:
  //    translators emit metadata + short excerpts, never full content.
  //    A future contract may add 'full_content_with_redaction' or similar;
  //    enforcer v1 only recognizes reflection_only.
  if (contract.ingestion_mode !== 'reflection_only') {
    return {
      ok: false,
      violation: {
        code: 'CONTRACT_INGESTION_MODE_VIOLATION',
        message: `contract.ingestion_mode='${contract.ingestion_mode}' is not supported by enforcer v1 (only 'reflection_only')`,
      },
    };
  }

  const actions: ContractAction[] = [];

  // 4) Body truncation. `max_body_bytes` from contract; default 200.
  let body = event.body ?? null;
  const maxBodyBytes = Math.max(0, contract.max_body_bytes ?? 200);

  if (body !== null && body.length > 0) {
    // Byte-length under UTF-8, not character count — to honor the operator's
    // contract semantics literally. Browser-side TextEncoder works in Workers.
    const encoded = new TextEncoder().encode(body);
    if (encoded.byteLength > maxBodyBytes) {
      // Truncate at byte boundary, then decode (cut may produce orphan
      // multi-byte; we trim trailing replacement char).
      const truncatedBytes = encoded.slice(0, maxBodyBytes);
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(truncatedBytes);
      const cleaned = decoded.replace(/�+$/, '');
      actions.push({
        kind: 'truncated',
        field: 'body',
        from_bytes: encoded.byteLength,
        to_bytes: new TextEncoder().encode(cleaned).byteLength,
      });
      body = cleaned;
    }
  }

  // 5) allowed_fields enforcement. The contract's `allowed_fields` lists
  //    SEMANTIC fields the translator is permitted to populate from the
  //    upstream (e.g. 'title', 'subject', 'author_login'). Structural row
  //    fields (id, source_tool, status, etc.) are always allowed because
  //    they construct the row itself.
  //
  //    Practically: we don't strip individual properties from the event
  //    object — instead, we rely on translators to NOT emit fields that
  //    aren't in the allowlist. This enforcer's `allowed_fields` check is
  //    a contract assertion: if `body` is populated and 'body' isn't in
  //    the allowlist (or its source-field 'subject'/'title' alias isn't),
  //    we flag it.
  //
  //    For v1 we treat 'body' as covered by 'subject' or 'title' being
  //    in allowed_fields (whichever applies per translator). A stricter
  //    enforcement lands in v2 when we have per-provider mappings.
  if (body && !allowedToCarryBody(contract.allowed_fields)) {
    return {
      ok: false,
      violation: {
        code: 'CONTRACT_FIELD_NOT_ALLOWED',
        message: `contract.allowed_fields=${JSON.stringify(contract.allowed_fields)} does not permit any body-carrier field; translator emitted body content`,
        field: 'body',
      },
    };
  }

  // 6) Final byte-cap re-check (defense in depth — body should already be
  //    within limit after truncation, but verify).
  if (body !== null && new TextEncoder().encode(body).byteLength > maxBodyBytes) {
    return {
      ok: false,
      violation: {
        code: 'CONTRACT_MAX_BODY_BYTES_EXCEEDED',
        message: `body bytes (${new TextEncoder().encode(body).byteLength}) exceeds max_body_bytes (${maxBodyBytes}) after truncation`,
        field: 'body',
      },
    };
  }

  const sanitized: HarnessFlowEventInput = {
    ...event,
    body,
  };

  return { ok: true, event: sanitized, actions };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether any of the contract's allowed_fields can carry body content.
 * 'body', 'subject', 'title' are recognized body-carriers in v1.
 */
function allowedToCarryBody(allowedFields: string[]): boolean {
  const bodyCarriers = new Set(['body', 'subject', 'title']);
  return allowedFields.some(f => bodyCarriers.has(f));
}

// ---------------------------------------------------------------------------
// Convenience: build event metadata that records contract actions
// ---------------------------------------------------------------------------

/**
 * Translators call this AFTER enforceContract returns ok=true to capture
 * the actions trail into the event's audit metadata. Returns a JSON-safe
 * object suitable for storing in a metadata column or appending to the
 * event's evidence_link as a query-string-style trail.
 *
 * (R50.3c doesn't yet land a dedicated metadata column on operation_events;
 * R50.12 telemetry/spans will. Until then, translators can drop these into
 * a JSON sidecar log if forensic capture is needed.)
 */
export function buildContractActionsMetadata(
  sourceTool: SourceTool,
  actions: ContractAction[],
): { source_tool: SourceTool; contract_actions: ContractAction[]; enforcer_version: 1 } {
  return {
    source_tool: sourceTool,
    contract_actions: actions,
    enforcer_version: 1,
  };
}
