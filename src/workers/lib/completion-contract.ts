// completion-contract.ts · Wave I backend (260714) · the Definition-of-Done gate, as a PURE evaluator.
//
// The product doctrine (DESIGN-ASK canonical-lifecycle doc §11 / Phase 10): "output produced" is NOT
// "event completed". A governed Event may transition to \`completed\` only when its completion contract
// passes. This module is the single place that decides that — a pure function (no ctx / no DB / no I/O,
// mirroring allowed-actions.ts) so it is unit-testable, cannot leak tenant data, and can be wired into
// the packet lifecycle transition later behind a flag. INERT until wired: no route imports it yet.
//
// Each of the nine preconditions maps to an existing column set (see the backend map): requested output +
// acceptance (task_packets.summary / plan goal contract), evidence (evidence_items / evidence_ref_ids),
// execution finished (tool_events.status), blockers (operation_events.status='blocked'), approval +
// approved-version (approval_requests.status='approved' + approval_state), receipt (evidence_items
// kind='receipt'), plan projection (synthetic_domain_goals / plan_entities rollup).

export interface CompletionInput {
  /** A concrete requested output/artefact exists for the packet (not just a started run). */
  hasRequestedOutput: boolean;
  /** Whether this packet declares acceptance criteria at all. */
  acceptanceCriteriaRequired: boolean;
  /** The declared acceptance criteria evaluated true. Ignored when not required. */
  acceptanceCriteriaPass: boolean;
  /** Whether evidence is mandatory for this packet's class. */
  evidenceRequired: boolean;
  /** Count of evidence items attached (never ids — counts-only, customer-safe doctrine). */
  evidenceAttachedCount: number;
  /** Execution has terminated (tool_events terminal / lifecycle advanced past in_progress). */
  executionFinished: boolean;
  /** Count of still-open blockers on this request (operation_events.status='blocked'). */
  openBlockerCount: number;
  /** The operator explicitly accepted the remaining blocker(s) as non-fatal. */
  blockersExplicitlyAccepted: boolean;
  /** Whether an approval/sign-off is required before completion. */
  approvalRequired: boolean;
  /** A recorded approval/sign-off exists (approval_requests / sign_offs = approved). */
  approvalPresent: boolean;
  /** The version the approval was recorded against (null = no approval). */
  approvedVersion: number | null;
  /** The current version of the packet/result. A newer version invalidates a stale approval. */
  currentVersion: number;
  /** A durable receipt exists (evidence kind='receipt' / chat_receipt / snapshot receipt). */
  receiptPresent: boolean;
  /** The linked plan/goal/milestone rollup reflects this work (projection updated). */
  planProjectionUpdated: boolean;
}

export interface CompletionVerdict {
  can_complete: boolean;
  /** Human-readable reasons the contract is not yet satisfied. Empty ⇒ can_complete. */
  unmet: string[];
}

/**
 * Evaluate the nine-condition completion contract. PURE. Returns every unmet reason (not fail-fast) so a
 * UI can show the full checklist. \`can_complete\` is true iff \`unmet\` is empty.
 */
export function evaluateCompletion(input: CompletionInput): CompletionVerdict {
  const unmet: string[] = [];

  if (!input.hasRequestedOutput) unmet.push('the requested output does not exist yet');

  if (input.acceptanceCriteriaRequired && !input.acceptanceCriteriaPass)
    unmet.push('the acceptance criteria have not passed');

  if (input.evidenceRequired && input.evidenceAttachedCount < 1)
    unmet.push('required evidence is not attached');

  if (!input.executionFinished) unmet.push('execution has not finished');

  if (input.openBlockerCount > 0 && !input.blockersExplicitlyAccepted)
    unmet.push(
      input.openBlockerCount + ' blocker' + (input.openBlockerCount === 1 ? '' : 's') +
        ' still open and not explicitly accepted',
    );

  if (input.approvalRequired) {
    if (!input.approvalPresent) {
      unmet.push('required approval is missing');
    } else if (input.approvedVersion === null || input.approvedVersion !== input.currentVersion) {
      unmet.push(
        'the approval is stale (approved v' + String(input.approvedVersion) +
          ' but current is v' + String(input.currentVersion) + ')',
      );
    }
  }

  if (!input.receiptPresent) unmet.push('no durable receipt exists');

  if (!input.planProjectionUpdated) unmet.push('the linked plan projection has not been updated');

  return { can_complete: unmet.length === 0, unmet };
}
