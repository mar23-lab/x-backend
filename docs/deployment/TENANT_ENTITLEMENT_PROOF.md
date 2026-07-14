# Tenant Entitlement Proof

Every customer-feedback tenant needs an entitlement proof before `test.xlooop.com` can be treated as a live external test surface.

Required fields live in `deployment/cloudflare/tenant-entitlements.example.json`.

## Required Decisions

- Customer tenant id.
- Cloudflare Access identity or group.
- Invitation code expiry and rate-limit posture.
- Xlooop first-level access enabled.
- Default action mode: Watch/proposal-only.
- Operator mode: disabled unless owner/admin approves.
- XCP second-level entitlement: disabled unless separately enabled per user.
- Customer-safe export manifest path and hash.
- Authority/consent evidence references.

## Why This Exists

The access code can only route a tester to the correct tenant. It must never become the security boundary. Cloudflare Access proves identity, tenant entitlement proves authorization, and Xlooop action-mode gates prove that a click cannot affect a real system without the right mode and receipt path.
