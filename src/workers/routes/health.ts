// health.ts · GET /api/v1/health · uptime check (no auth)
//
// Authority: API_CONTRACT_V1.md §GET /api/v1/health

import { Hono } from 'hono';
import { isSentryActive } from '../sentry';

export const healthRoute = new Hono();

healthRoute.get('/health', (ctx) => {
  // `version` is the API CONTRACT version (semver) — it is NOT a deploy signal and is
  // intentionally constant. `build` / `built_at` ARE the deploy signal: they are injected
  // at `npm run deploy:api` (--var BUILD_SHA / BUILD_TIME) and CHANGE per deploy, so a
  // consumer can confirm the exact live commit. Per HR-CONFIG-REALITY-MATCH-1: never infer
  // deploy/release state from a hardcoded constant — use a value that tracks reality.
  // Falls back to 'dev' / null when run locally or deployed without injection.
  const env = ctx.env as { BUILD_SHA?: string; BUILD_TIME?: string };
  return ctx.json({
    status: 'ok',
    version: '1.0.0',
    build: env.BUILD_SHA || 'dev',
    built_at: env.BUILD_TIME || null,
    // A-W6 · public-safe activation signal: true iff the SDK is bound to a valid (parseable) DSN — the
    // honest getDsn() probe, not merely a bound client. (The temporary DSN-shape triage fields — dsn_len,
    // dsn_looks_like_url — were removed once the malformed-DSN incident was resolved 260707.)
    sentry_active: isSentryActive(),
    timestamp: new Date().toISOString(),
  });
});
