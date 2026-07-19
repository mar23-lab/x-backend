// ugec-fence.ts · UGEC gap-2 — the packet tool-fence, made real (ADR-XB-008).
//
// Before this module, task_packets.allowed_tools / forbidden_tools and the
// customer-token packet_prefix were DECLARATIVE-ONLY: hydrated, signed into the
// MCP envelope, and never checked server-side. This is the pure decision unit;
// the gateway wires it born-SHADOW (warn-log) and flips to deny only under
// UGEC_FENCE_ENFORCEMENT (per the shadow → ratchet → enforce doctrine).
//
// Pure by design: no ctx, no dal, no env — trivially unit-testable.

export interface UgecFenceInput {
  packet_id: string;
  /** customer_api_tokens.packet_prefix carried on the auth context ('' = unscoped). */
  packet_prefix?: string | null;
  /** task_packets.allowed_tools — empty array means "no allow-list declared". */
  allowed_tools?: readonly string[] | null;
  /** task_packets.forbidden_tools — always enforced when non-empty. */
  forbidden_tools?: readonly string[] | null;
  /** The tool action being reported; omit for non-tool writes (evidence, approvals). */
  action?: string | null;
}

export type UgecFenceViolation =
  | 'packet_prefix_scope'   // packet_id outside the token's packet_prefix scope
  | 'forbidden_tool'        // action explicitly forbidden by the packet
  | 'tool_not_in_allowed';  // packet declares an allow-list and the action is not on it

export function evaluateUgecFence(input: UgecFenceInput): UgecFenceViolation[] {
  const violations: UgecFenceViolation[] = [];
  const prefix = (input.packet_prefix ?? '').trim();
  if (prefix && !input.packet_id.startsWith(prefix)) {
    violations.push('packet_prefix_scope');
  }
  const action = (input.action ?? '').trim();
  if (action) {
    const forbidden = input.forbidden_tools ?? [];
    if (forbidden.includes(action)) {
      violations.push('forbidden_tool');
    } else {
      const allowed = input.allowed_tools ?? [];
      if (allowed.length > 0 && !allowed.includes(action)) {
        violations.push('tool_not_in_allowed');
      }
    }
  }
  return violations;
}
