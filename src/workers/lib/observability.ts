// observability.ts · T3/P6 (260710) · the ONE structured-event emitter.
//
// Before this, every structured log inlined `console.log(JSON.stringify({...}))` — only 5 event kinds
// existed across the whole worker (spine_authority.deny, role_scoped_context, cockpit_chat_llm_*,
// member_authority_provisioning.failed, email-notifier) and the plan's P6 events (tool calls, source
// syncs, fact-bundle assembly, document uploads, evidence/approvals) were DB-rows-only — invisible to
// log-based observability. This helper is the single chokepoint: one line per emission site, one shape,
// one place to later fan out to an external sink.
//
// CONTRACT: log-only + fire-safe (an emission can NEVER throw into the request path). Payloads must be
// small metadata (ids/counts/statuses) — never document content, tokens, or raw customer text. The `kind`
// vocabulary below is the greppable catalog; add new kinds HERE so the catalog can't drift silently.

/** The structured-event vocabulary (P6). Extend here — the manifest gate greps this list. */
export type ObservabilityKind =
  | 'tool_event_reported'      // an MCP/spine tool event landed (mcp-gateway)
  | 'source_sync_completed'    // a provider sync succeeded (sources route)
  | 'source_sync_failed'       // a provider sync failed (sources route)
  | 'chat_fact_bundle'         // an LLM grounding bundle was assembled (customer plane)
  | 'document_uploaded'        // a document row + spine event landed (documents route)
  | 'evidence_created'         // an evidence item landed (mcp-gateway)
  | 'approval_requested'       // an approval request landed (mcp-gateway)
  | 'signoff_decided'          // a human sign-off decision landed (sign-offs route)
  | 'feedback_submitted'       // a Test-mode feedback annotation persisted (feedback route)
  | 'mcp_customer_read'        // an MCP tenant read tool was invoked (mcp-customer-reads · L2 260710-D)
  | 'llm_usage'                // an LLM answer's per-tenant token usage was metered (llm-usage-store · G2 260711)
  | 'policy_shadow_decision'   // a policy-engine evaluator fired on a governed write in SHADOW mode (policy-shadow · A7 260713)
  | 'role_skill_resolution'    // the role/skill resolver observed a governed-write decision in SHADOW mode (role-skill-shadow · OAR-W2 260713)
  | 'role_skill_receipt_write_failed'; // a shadow receipt write rejected — telemetry so evidence loss is never silent (role-skill-shadow · Track A 260713)

/** Emit one structured observability event. Never throws; never blocks. */
export function emitEvent(kind: ObservabilityKind, payload: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ kind, ...payload }));
  } catch { /* observability must never break the request */ }
}
