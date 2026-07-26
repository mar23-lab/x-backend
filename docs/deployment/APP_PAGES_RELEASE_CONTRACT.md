# App Pages Release Contract

`x-ai-front` owns the customer frontend source and static production artifact.
`x-backend` owns the Cloudflare Pages Functions and the guarded assembly/deploy procedure.
This is one deployed frontend with a cross-repository release boundary, not a second app.

## Required sequence

1. Build `x-ai-front/wired/dist-production` from a clean committed frontend SHA. Set:
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

3. Obtain an exact operator decision packet using
   `docs/deployment/evidence/app-pages-deployment-decision.example.json` as the shape.
   The packet must name both candidate SHAs, expected backend contract/schema/posture,
   a distinct rollback frontend deployment, and a short-lived authorization UUID.
4. Deploy only the assembled release:

   ```sh
   XLOOOP_APP_PAGES_DECISION_PACKET=/absolute/path/to/approved.json \
     npm run deploy:app:prod
   ```

5. Record the returned Pages deployment ID and perform live artifact, auth, journey,
   security-header, and rollback probes:

   ```sh
   XLOOOP_REQUIRE_SENTRY=1 npm run verify:app-pages-live
   ```

   This compares the live release manifest, public asset hashes, injected frontend
   release, security headers, and backend health tuple with the assembled candidate.
   Deployment is not a commercial-readiness claim.

## Enforced invariants

- `window.__XLOOP_FRONTEND_SHA` is exact and equals the Pages commit hash.
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
- No deploy runs without an exact, unconsumed operator approval packet.
- The assembled `_worker.js` is uploaded without rebundling, preserving its manifest hash.
