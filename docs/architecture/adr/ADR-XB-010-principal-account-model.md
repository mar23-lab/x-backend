# ADR-XB-010 — The Principal Account Model (one person · one account · portfolio plane)

- **Status:** accepted (ratified by operator decision, 2026-07-20 — Marat Basyrov, session 260720; PART-X plan approval)
- **Date:** 2026-07-20
- **Authority context:** ADR-XB-001 (tenant vs workspace; "one tenant : many workspaces" deferred structure); CANONICAL_DOMAIN_MODEL §1 (portfolio selector), §3 (workspace owns portfolio objectives), §4 (context-assembly precedence), §5 (adaptive labels); mig 085 workspace typing; the 260720 prod tenancy verification.

## Decision

**One person = one account.** A principal (one Clerk identity) holds MANY workspaces: exactly one
PERSONAL workspace (their life domains, rendered "Areas") plus zero-or-more COMPANY workspaces
(rendered "Departments"), plus external memberships granted by others. The operator's own account is
the reference instance: MB-P = the personal workspace (customer_zero) and Xlooop = the company
workspace, in ONE marat@xlooop.com account. Separate accounts per life/company are REJECTED — they
split the principal's context, so agents in each fragment produce incomplete recommendations that
compete for the same finite hours (the single-principal trade-off argument).

**The principal-portfolio plane.** Because one person's priorities span their workspaces, the model
adds a PRIVATE cross-workspace layer: the portfolio — the principal's own objectives/priorities
aggregated across the workspaces they are an active member of.

1. It is a READ-MODEL union over the principal's memberships (no schema change; `plan_entities`
   already carries scope columns; no tenant-table migration — consistent with ADR-XB-001's deferral).
2. **UI cost: no new surface class.** One additional entry in the existing workspace switcher
   ("All my work"), rendering the EXISTING PLAN-pane component at `scope_ref = principal`. The entry
   appears ONLY when the principal has more than one workspace — single-org enterprise users never
   see it (enterprise positioning unchanged).
3. **PRIVACY INVARIANT (hard):** portfolio content is visible ONLY to the principal and enters
   context assembly ONLY for the principal's own sessions, as an optional top layer ABOVE the §4
   chain. It is never stored in any workspace and never rendered to any other member. Personal-life
   context MUST NOT leak into shared company surfaces. A leak test enforces this (client-visibility
   suite).
4. Workspace isolation is unchanged: RLS stays workspace-keyed; the portfolio reads only workspaces
   the principal is an active member of, through the same membership checks.

**Personal-workspace provisioning (the auth gap this ADR closes on paper).** Runtime auth requires a
Clerk org (orgless sessions are 403 by design). Therefore a general user's personal workspace is
backed by a **personal Clerk organisation auto-provisioned at signup** (the operator's mbp-private
currently rides the trusted-operator fallback — the reference implementation of the same shape).
Implementation rides the self-serve program (M-C); no fallback-widening for external users.

**Multi-company:** more companies = more company workspaces in the same account (Clerk multi-org;
one active at a time; the portfolio spans them). This is the documented setup pattern for any user:
enterprise-first (join your company workspace), personal use = one more workspace, never a second
account.

## Consequences

- The blog-article story ("your personal life + the companies you run, one account") is the same
  mechanism enterprise users already have — zero extra product surface for the enterprise ICP.
- Agent recommendations become complete for multi-workspace principals (the portfolio layer closes
  the fighting-for-hours gap).
- Census/tenant semantics unchanged; personal workspaces are real tenants (customer_zero pattern).
- The structural tenant split (ADR-XB-001) remains deferred; this ADR adds no tables.
