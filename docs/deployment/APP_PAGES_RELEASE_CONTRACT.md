# App Pages Release Contract

`x-ai-front` owns the customer frontend source and static production artifact.
`x-backend` owns the Cloudflare Pages Functions and the guarded assembly/deploy procedure.
This is one deployed frontend with a cross-repository release boundary, not a second app.

## Required sequence

1. Build `x-ai-front/wired/dist-production` with the governed `wired/scripts/build-mode.mjs`
   `build:production` producer from a clean committed frontend SHA. `project/App.dc.html` is a
   demo-derived UX/control specification, not executable production source and not a deployable artifact. Set:
   - `XLOOOP_FRONTEND_SHA=<exact 40-character frontend commit>`
   - `XLOOOP_EXPECTED_BACKEND_SHA=<exact x-backend commit>`
   - the production API, schema, authority, environment, and feature-posture values.
2. In the exact backend checkout, assemble the release:

   ```sh
   XLOOOP_FRONTEND_ARTIFACT_DIR=/absolute/path/to/wired/dist-production \
     npm run prepare:app:prod
   npm run verify:app-pages-release
   ```

   Assembly compiles Pages Functions and normalizes Wrangler's randomized
   `functionsRoutes-<random>.mjs` source comment before hashing. The normalizer
   changes comments only, requires exactly one recognized generated marker, and
   fails closed on missing, duplicate, or unfamiliar Wrangler temporary-path
   comments. This keeps `_worker.js/index.js` in the immutable manifest without
   allowing build-directory randomness to masquerade as source drift.

3. Obtain matching API and Pages operator decision packets. Both packets must carry the same
   `cutover_id`, approver, approval reference, candidate tuple, artifact digest, and rollback pair.
   Use
   `docs/deployment/evidence/app-pages-deployment-decision.example.json` as the shape.
   The packet must name both candidate SHAs, expected backend contract/schema/posture,
   a distinct rollback frontend deployment, and a short-lived authorization UUID.
4. Deploy the pair through the only production mutation command:

   ```sh
   XLOOOP_AUTHORITY_DECISION_PACKET=/absolute/path/to/api-approved.json \
   XLOOOP_APP_PAGES_DECISION_PACKET=/absolute/path/to/approved.json \
     npm run deploy:paired:prod
   ```

   `deploy:api` and `deploy:app:prod` are aliases of this paired orchestrator. Standalone Pages
   mutation is refused. The orchestrator reserves both single-use approvals before mutation,
   deploys and ratifies the API, deploys and ratifies Pages, and automatically restores the
   declared Pages/API rollback pair if any post-mutation step fails.

5. Preserve the paired cutover receipt and perform authenticated journey,
   security-header, and rollback probes:

   ```sh
   XLOOOP_REQUIRE_SENTRY=1 npm run verify:app-pages-live
   ```

   This compares the live release manifest, public asset hashes, injected frontend
   release, security headers, and backend health tuple with the assembled candidate.
   Deployment is not a commercial-readiness claim.

## Enforced invariants

- `runtime-manifest.json` uses `xlooop.frontend_runtime_manifest.v3`, names the exact frontend SHA,
  backend SHA, contract hash, schema, posture and authority, and is carried into the immutable release.
- The versioned runtime manifest is the rich UI v3 artifact and live-pairing authority; the compiled
  artifact carries the same runtime pins and fails closed against backend health.
- The backend verifies the runtime manifest's per-file hashes before assigning the frontend SHA,
  and live ratification verifies the served HTML shell, manifest bytes, and every public release file.
- The API packet, Pages packet, and assembled manifest carry one immutable artifact digest and exact
  schema/contract/feature-posture tuple. Any cross-surface mismatch is refused before authorization
  consumption.
- The rich UI v3 artifact contains only compiler-approved static runtime files and has no
  deployment-header authority. Backend assembly always emits production `_headers` from
  `data/security-headers.manifest.json`; raw `project/App.dc.html`, `wired/src`, and demo-local
  conversational success paths cannot enter the assembled release.
- The frontend's expected backend SHA equals the backend checkout `HEAD`.
- Frontend build and backend assembly/deploy checkouts are clean; dirty code cannot inherit a committed SHA.
- The embedded contract hash equals `x-backend/docs/contracts/api-contract.v1.json`.
- The release contains the compiled Pages Functions and immutable file hashes.
- Repeated builds of the same Pages Functions source produce the same normalized
  `_worker.js/index.js` hash; the deployed bytes are the bytes recorded in the
  manifest.
- The manifest timestamp comes from the backend commit, so identical source inputs remain reproducible.
- Pages Sentry release identity comes from the frontend artifact SHA. A mutable
  `SENTRY_RELEASE` secret is only a compatibility fallback for legacy artifacts.
- No deploy runs without an exact, unexpired, unconsumed operator approval packet whose validity
  window is no longer than 30 minutes.
- Worker rollback version and Pages rollback deployment IDs are mapped to their declared Git SHAs
  before mutation; formatted-but-unrelated UUIDs are refused.
- API health ratification requires a structurally valid versioned model-runtime keyring. Secret
  names alone cannot make a release green.
- Deployment authorization receipts live under the repository's Git common directory, so every
  worktree sees the same consumed token. The token is reserved before Cloudflare is called; a failed
  or interrupted deployment attempt requires a new operator authorization.
- The assembled `_worker.js` is uploaded without rebundling, preserving its manifest hash.
