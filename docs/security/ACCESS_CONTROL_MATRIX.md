# Access-control matrix (SSOT · v1 · 2026-07-07)

The role × resource × action matrix AS ENFORCED IN CODE today (evidence-bound). This is the server
truth the M4 `allowed_actions` response envelope will project per resource (Wave 2), and the server
half of the new UI's permission axes. Roles: migration 001 `workspace_members.role ∈ {owner,
operator, viewer, client}`; identity: Clerk JWT → `user_id`/`workspace_id`/`role` (middleware/auth.ts).

## Matrix (✅ allowed · ⛔ denied · Ⓞ owner-only extra)

| Resource / action | owner | operator | viewer | client | Enforcement evidence |
|---|---|---|---|---|---|
| Events: read (visibility-filtered) | ✅ all tiers | ✅ ws+proj+public | ✅ proj+public | ✅ public_safe only | visibilityForRole + RLS (043) |
| Events: create/status re-point | ✅ | ✅ | ⛔ | ⛔ | event routes role guards; content immutable (042) |
| Events: archive/restore (soft) | ✅ | ✅ | ⛔ | ⛔ | 30d window (RETENTION_POLICY) |
| Projects/board/bindings: read | ✅ | ✅ | ✅ | ⛔ | RLS 045/047 |
| Project sources: read | ✅ | ✅ | ✅ | ⛔ (403 explicit) | projects.ts:367 "client role cannot read project sources" |
| Sources: connect/disconnect(soft)/reconnect | ✅ | ✅ | ⛔ | ⛔ | sources.ts + 044 |
| Sign-offs / decisions | ✅ | ✅ | ⛔ | ⛔ | sign-off routes; verdict recorded immutable |
| Members: list | ✅ | ✅ | ✅ | ⛔ | members.ts (membership-gated; non-member 403; client 403 ENFORCED A-W2c — the route previously lacked the client guard this row documented, a matrix↔code drift fixed 260707) |
| Members: role change | Ⓞ owner-only, last-owner-guarded, audited | ⛔ | ⛔ | ⛔ | members.ts:77 PATCH |
| API tokens: mint/revoke | ✅ | ✅ (scoped) | ⛔ | ⛔ | migration 037: viewer-scope (read MCP) vs operator-scope (packet_prefix-bounded writes); instant revocation |
| Customer-data export/delete requests + execute | Ⓞ/operator, approval-gated | ✅ | ⛔ | ⛔ | operational-spine.ts:301-391 (two-step request→approve→execute) |
| Team invitations (Clerk) | ✅ gated | ✅ gated | ⛔ | ⛔ | clerk-org.ts — hard-gated on dual-signed authority consent (migration 018) |
| Audit log read | Ⓞ platform-operator only (`MBP_OWNER_USER_ID`) | ⛔ | ⛔ | ⛔ | workspaces.ts:415 (tenant-scoped customer audit view = Wave-2 E2) |
| MB-P projections | Ⓞ platform operator only | ⛔ 403 | ⛔ | ⛔ | mbp-projection.ts |

## Cross-cutting invariants
1. **Authority is server-derived, never client-computed** (GAP-004 lesson). LANDED as M4: `allowed_actions` +
   `disabled_reasons` are projected per response by the pure authority module `src/workers/lib/allowed-actions.ts`
   (`withAuthority()`), faithful to this matrix. Adopted on projects (list/read/sources), events, and user
   sources. Frozen by `verify:allowed-actions-server-derived` (no hand-rolled lists · module stays pure) +
   the matrix vitest `__tests__/allowed-actions.test.ts` (in `verify:ip-boundary-suite`).
2. **Tenant boundary before role:** membership in the workspace precedes any role check (auth middleware + RLS).
   RLS runtime enforcement (17/20 customer tables live, DSN bound) is frozen by `verify:rls-runtime-enforcement`
   (A-W3): every customer read of an RLS-policy table uses the non-owner `this.rlsSql` client (the owner
   client bypasses RLS); operator-overlay reads (`…ForOperator`, multi-workspace `workspace_id = ANY(owned)`)
   are exempt by design. A refactor flipping a read to the owner client now fails ci-local.
3. **Two-key destructive ops:** customer-data delete = request (with reason) → approval → execute, each audited.
   Audit COVERAGE of the authority-critical mutations (member role change, access approve/reject, sign-off
   verdict, authority revoke, decision, provisioning, user-status) is frozen by `verify:audit-coverage` (M5):
   each DAL mutation must keep its `INSERT INTO audit_logs` write or ci-local fails.
4. **Service principals:** canary tokens are SHA-256-pinned env credentials, scoped read-only (middleware/auth.ts).
5. **External invite least-privilege** — target posture; verification test = M-sprint item (not yet proven; tracked in COMMERCIAL_READINESS_DOD.md).

## Gaps (tracked)
Audit **CSV/JSONL export** = LANDED (E2): `GET /api/v1/audit-log?format=csv|jsonl` streams the trail as a
downloadable file (frozen column order; `src/workers/lib/audit-export.ts`, proven in
`__tests__/audit-export.test.ts`). **Session-event audit rows** (token mint/revoke, sign-in/out) = STAGED:
migration `048_audit_session_target_types.sql` widens `audit_logs.target_type` to `+api_token +session`
(**APPLIED to prod 2026-07-06T18:10Z** — `workers_schema_version` v48, verified live); the route-layer best-effort
INSERTs activate on apply. Per-resource `allowed_actions`/`disabled_reasons` = M4 (landed, above). Dept-gate
authority (new-UI concept: domain owner signs off tagged events) = design note in 23_NEW_UI_CONTRACT_GAP_MAP.md.
