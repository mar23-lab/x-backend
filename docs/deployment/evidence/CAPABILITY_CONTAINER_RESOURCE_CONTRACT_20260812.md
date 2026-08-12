# Capability Container Resource Contract

Status: PASS for isolated pilot-shadow runtime.

## Decision

The capability adapter container must declare this minimum instance profile:

- vCPU: `1`
- memory: `3072 MiB`
- disk: `4000 MB`
- maximum instances: `3`

The adapter remains private, no-egress, tenant-allowlisted, feature-flagged, and disabled by default.

## Evidence

The first Cloudflare rollout used the implicit `lite` profile (`256 MiB`, `2 GB` disk). Cloudflare rejected the image during unpack with `ImagePullRequestedDiskSizeToSmall`. The image and registry upload were valid; the deployment resource profile was not.

The corrected version uses `1 vCPU`, `3072 MiB` memory, and `4000 MB` disk. Cloudflare application `a0367097-1954-485b-82de-4201f60a8286` subsequently reported:

- rollout version `2`: `100%`
- healthy instances: `3/3`
- failed, starting, scheduling, or stopped instances: `0`
- image tag: `xlooop-capability-adapter-capabilitysandbox:905c759d`

Runtime observation time: `2026-08-12T07:48:17Z` UTC (`2026-08-12 17:48:17` Australia/Melbourne).

Source verifier: `npm run verify:external-capability-runtime-adapter`.

## Prevention

`scripts/verify-external-capability-runtime-adapter.mjs` now rejects the implicit `lite` profile or any drift from the ratified minimum tuple. A deploy command succeeding is not operational proof; rollout health must show the intended version at `100%`, all expected instances healthy, and zero rollout errors.

This receipt does not authorize production deployment or default-enable MarkItDown or Headroom.
