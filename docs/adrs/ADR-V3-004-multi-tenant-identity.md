# ADR-V3-004 · Multi-tenant identity model

**Status:** Accepted
**Date:** 2026-05-03
**Decision-makers:** Marat
**Supersedes:** earlier "Client Review with visibility-filter projection" framing (treated client as a render-time filter only)
**Cross-link:** [ADR-V3-001](ADR-V3-001-v3-canonical-saas-frontend.md), x-front `src/app/providers/AuthProvider.tsx`, [risk-register.md D6](../risk-register.md)

## Context

The v2 build had a "Client Review" surface that rendered a *filtered projection* of agency content for the client to see — a render-time visibility filter only. The client was not a first-class user; the agency owned the workspace, and the client got a read-only view.

This is too thin for v3:

- Clients in real engagements are CEO-level. They need their own identity, their own workspace, and the ability to engage with multiple agencies.
- A signed URL is fine for "preview this delivery package" but not for ongoing collaboration.
- Multi-tenant networks ("Agency A delivers for Client B" + "Client B is also a customer of Agency C" + "Client B has internal teams of their own") are the actual product surface.

## Decision

**Client = first-class user.** Two access modes are supported:

1. **Signed-URL mode** — read-only review. Anyone with a valid signed URL can open a read-only client-safe projection of a deliverable. No login required. Used for one-off "look at this" moments.
2. **Registered-user mode** — the client signs up / logs in → gets their own workspace → can be invited to one or more company workspaces by other agencies/clients. Bidirectional.

The data model:

- Every workspace has an `owner_user_id` and a list of `members[]`. A client is just a member with a specific `role`.
- Invitations are first-class records. Accepting an invitation grants membership.
- `visibility` tags (`system-internal | agency-visible | client-visible`) still govern what gets rendered for which member; visibility is now a *render filter on top of identity*, not a substitute for identity.

Identity provider: x-front's `AuthProvider` is the canonical seam (TypeScript). v3 uses a stub-token implementation today; swaps to real auth (OIDC / passkeys / pick-one) when backend lands.

Permissions hierarchy (per ADR-V3-005): Company (workspace) → Project → User personal. A client invited to a company workspace gets the Company-level policy applied; further restrictions come from Project policy.

## Consequences

**Positive:**
- Clients can self-register and bring their own workspaces — multi-tenant story is real.
- Agencies can invite multiple clients; clients can be members of multiple agencies; networks form naturally.
- Visibility filter remains useful but not load-bearing for identity.
- Pitch wording supported: "Your client logs in — they don't need to be onboarded by you. They can also bring their own team."

**Negative:**
- Identity flow is bigger than a render filter — Phase 5 of the roadmap takes ~3 days for the foundation (signed URL first, registration flow second).
- Real backend dependency for production (signed-URL mode works without backend; registration does not).
- Workspace ownership rules need explicit governance (who can invite, who can revoke).

**Out of scope:**
- Specific auth provider choice (OIDC vendor, passkey provider, etc.) — owned by ops + security tracks.
- Billing / seats — out of scope for the demo.
- Federated identity across multiple agencies — captured as a future ADR if a customer requests it.

## Verification

- `v3/project/v3/contracts/` contains a `user`, `membership`, `invitation` contract kind once Phase 3.x ports complete.
- `runtime/redaction.ts` (post-Phase 2.4) reads `visibility` from the merged policy + member's role.
- Phase 5.1 of roadmap: signed-URL adapter shipped; Playwright spec covers "open URL → see read-only review."
- Phase 5.2 of roadmap: registration flow shipped; Playwright spec covers "register → workspace created → invited to company → membership accepted."

## References

- x-front `src/app/providers/AuthProvider.tsx`
- [ADR-V3-005 skills hierarchy](ADR-V3-005-skills-hierarchy.md)
- [risk-register.md D6](../risk-register.md)
- [demo-ux-blueprint.md](../demo-ux-blueprint.md) (Client Review scene)

## Amendment · 2026-05-04 · D22 hardening (stub-crypto labeling layers)

The signed-URL `sig` field uses FNV-1a hash + `__V3_BUILD` constant. **This is NOT a signature** — it is a forgeable shape-token that lets the demo prove "session expired" / "tampered claims" code paths without a backend. Real crypto is architecturally blocked until backend lands; this amendment codifies the four labeling layers active today and the lift trigger.

### Why no real crypto today (architectural constraint)

A real signature requires a key the client cannot read. Three options each need a backend:
- **HMAC** with a server-held secret
- **JWT** with a server-side issuer's signing key
- **Backend-issued short-lived tokens**

Client-side-only "stronger crypto" (e.g. SHA-256, Web Crypto SubtleCrypto.sign with a hardcoded key) **does NOT solve the problem** — anyone with the bundle can read the algorithm and forge tokens. Stronger client-side hashing would be misleading rather than safer; we stay on FNV-1a precisely because no one mistakes it for a signature.

### Active labeling layers (defense in depth · all client-side)

1. **Sticky DEMO banner** — `pages/client-review/ClientReview.jsx` renders `data-testid="cr-stub-banner"` at the top of every signed-URL session: `⚠️ DEMO SESSION · stub-signed token, not production crypto · anyone with the URL can decode all claims · do not use real customer data`. Visible until session terminates. Landed in T1-H.H6.
2. **Console warning on every mint** — `mintSignedUrlToken` in `shared/services/signed-url/SignedUrl.jsx` emits `console.warn('[v3] STUB CRYPTO · ...')` on every call. Anyone with DevTools open sees it. Suppressible only via `window.__suppressStubCryptoWarning = true` (used by tests). Landed 2026-05-04 (D22 hardening).
3. **runBootCheck flag** — `runBootCheck()` returns `{ stub_crypto: true, stub_crypto_adr: 'ADR-V3-004', stub_crypto_risk: 'D22' }`. CI/automation can refuse to promote a build to a production-ish environment while this is true. Landed 2026-05-04 (D22 hardening).
4. **Footer disclaimer** — small-print "Demo session · stub-signed token" in ClientReviewPane footer (Phase 5).

### Lift trigger (single decision point)

When backend lands AND `mintSignedUrlToken` uses a real signing scheme:
1. Replace FNV-1a sig with HMAC-SHA-256 (or JWT) using a server-issued key.
2. Flip `stub_crypto: false` in `runBootCheck`.
3. Remove `console.warn` from `mintSignedUrlToken`.
4. Hide the sticky DEMO banner (or repurpose for non-prod environments only).
5. Update this ADR with the chosen scheme and the commit that lands it.
6. Mark risk D22 as Resolved.

### Verification (D22 hardening · this amendment)

- smoke-cli `D22: signed-URL mintSignedUrlToken emits console.warn on every mint`
- smoke-cli `D22: runBootCheck exposes stub_crypto flag for CI/automation gating`
- Existing T1-H.H6 banner tests still pass (no regression)
- console.warn visible during signed-URL Playwright runs (console capture)
