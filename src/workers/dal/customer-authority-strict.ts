// customer-authority-strict.ts · the authority_strict (migration 093) helpers for the customer
// authority/consent commands.
//
// EXTRACTED FROM customer-authority-store.ts (260803). The strict rewrite added the single-statement
// CTE chains plus their claim-validation and replay-readback helpers, taking that store from ~340 to
// 549 lines and tripping the 500-line source-file-size ratchet. Splitting is the honest response —
// re-baselining the ratchet upward would spend a control to avoid a refactor.
//
// The split is along a real seam, not an arbitrary line count: everything here concerns the
// IDEMPOTENCY CLAIM (validate the key/digest, read back a replayed response, rehydrate a receipt
// from a stored body). The store keeps the business SQL. Nothing here issues a business write.

import { makeError } from './shared-helpers';
import type { Sql } from '../db/client';
import type {
  CustomerAuthorityWriteReceipt,
  CustomerConsentAckInput,
  RevokeCustomerAuthorityInput,
} from './types';

export type AuthorityStrictInput = Pick<
  CustomerConsentAckInput | RevokeCustomerAuthorityInput,
  'workspace_id' | 'idempotency_key' | 'request_sha256' | 'idempotency_route'
> & { actor_user_id: string };

/** Fail closed on a malformed strict claim BEFORE any business SQL runs. */
export function validateStrictInput(input: AuthorityStrictInput): void {
  if (!input.idempotency_key?.trim() || input.idempotency_key.length > 200) {
    throw makeError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required (1-200 chars)', 428);
  }
  if (!/^[a-f0-9]{64}$/.test(input.request_sha256)) {
    throw makeError('VALIDATION_ERROR', 'request_sha256 must be a lower-case SHA-256 value', 400);
  }
}

/** Rehydrate a receipt from a stored replay body, refusing a partial one. */
export function authorityReceiptFromBody(body: unknown, replayed: boolean): CustomerAuthorityWriteReceipt {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw makeError('INTERNAL_ERROR', 'strict authority replay body is unavailable', 500);
  }
  const receipt = body as Partial<CustomerAuthorityWriteReceipt>;
  if (
    !receipt.consent?.id
    || !receipt.authority_receipt_id
    || !receipt.audit_event_id
    || !receipt.operation_event_id
    || !receipt.projection_outbox_id
    || !receipt.read_model_watermark
  ) {
    throw makeError('INTERNAL_ERROR', 'strict authority replay body is incomplete', 500);
  }
  return { ...receipt, replayed } as CustomerAuthorityWriteReceipt;
}

/**
 * Read the stored response for a replayed strict command.
 *
 * Reached only from the 23505 duplicate-key handler: `strict_claim` is a plain INSERT with no
 * ON CONFLICT, so a genuine replay always arrives as a unique violation. A digest mismatch on the
 * same key is a DIFFERENT request reusing a key, which is 409 and never a replay.
 */
export async function readStrictAuthorityReplay(
  sql: Sql,
  input: AuthorityStrictInput,
): Promise<CustomerAuthorityWriteReceipt> {
  const rows = (await sql/*sql*/`
    SELECT request_sha256, response_status, response_body
    FROM idempotency_keys
    WHERE workspace_id = ${input.workspace_id}
      AND actor_user_id = ${input.actor_user_id}
      AND route = ${input.idempotency_route}
      AND idempotency_key = ${input.idempotency_key.trim()}
      AND mode = 'authority_strict'
    LIMIT 1
  `) as Array<{ request_sha256: string; response_status: number | null; response_body: unknown }>;
  const row = rows[0];
  if (!row) throw makeError('INTERNAL_ERROR', 'strict authority command did not create a replay record', 500);
  if (row.request_sha256 !== input.request_sha256) {
    throw makeError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request', 409);
  }
  if (row.response_status == null || row.response_body == null) {
    throw makeError('CUSTOMER_AUTHORITY_ATOMICITY_FAILED', 'authority command produced no durable result; retry with the same key', 500);
  }
  return authorityReceiptFromBody(row.response_body, true);
}
