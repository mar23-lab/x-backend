// vitest.workers.config.ts · Vitest config for src/workers/ tests
//
// Uses @cloudflare/vitest-pool-workers to run tests inside a Cloudflare Workers
// runtime (workerd) so the test environment matches production exactly.
//
// Run:    npm run test:workers
// Watch:  npm run test:workers:watch

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The installed test runtime (workerd compat 2024-12-30, via @cloudflare/vitest-pool-workers)
// PREDATES Workers-AI binding support — it can't resolve the `__WRANGLER_EXTERNAL_AI_WORKER` that
// the production `[ai]` binding requests, and Miniflare fails to START. The prod binding is required
// for the LLM-richer digest agent (services/agent-digest.ts) at deploy; tests that exercise the LLM
// path inject their OWN AI mock per-request (app.request(..., { ...ENV, AI })), so the runtime never
// needs the real binding. Fix: point the test pool at a DERIVED config = wrangler.toml minus the
// [ai] block (written to a gitignored sibling so relative `main`/paths still resolve). Zero-drift:
// it's regenerated from wrangler.toml on every test run.
const TEST_WRANGLER_PATH = path.resolve(__dirname, 'wrangler.test.generated.toml');
writeFileSync(
  TEST_WRANGLER_PATH,
  readFileSync(path.resolve(__dirname, 'wrangler.toml'), 'utf8').replace('[ai]\nbinding = "AI"\n', ''),
);

const liveRlsBindings =
  process.env.XLOOOP_RUN_LIVE_RLS === '1' && process.env.DATABASE_URL
    ? {
        XLOOOP_RUN_LIVE_RLS: '1',
        DATABASE_URL: process.env.DATABASE_URL,
      }
    : {};

export default defineWorkersConfig({
  // R-J-S2 (260602) · snakecase-keys@8.0.1 (via @clerk/backend) uses require() internally
  // but Miniflare tags it `?mf_vitest_no_cjs_esm_shim` (because it lacks a proper CJS
  // build), causing "Cannot use require() to import an ES Module" in 4 suites.
  // Vite resolve.alias redirects the import BEFORE Miniflare sees it, pointing to an
  // ESM-native shim that reimplements the minimal API @clerk/backend needs.
  resolve: {
    alias: {
      'snakecase-keys': path.resolve(
        __dirname,
        'src/workers/__tests__/__mocks__/snakecase-keys.mjs',
      ),
    },
  },
  test: {
    include: ['src/workers/**/__tests__/**/*.test.ts'],
    poolOptions: {
      workers: {
        // Bind the same wrangler config the production worker uses, so
        // bindings/vars match between tests and production.
        wrangler: { configPath: TEST_WRANGLER_PATH },
        // Per-test isolated workers (no shared state between tests).
        isolatedStorage: true,
        miniflare: {
          // Provide stub env values that don't require live secrets.
          // Tests that need real Clerk/Neon should set their own per-test env.
          bindings: {
            ENVIRONMENT: 'development',
            CLERK_JWKS_CACHE_TTL_SECONDS: '300',
            ALLOWED_ORIGIN_PATTERN: 'https://*.xlooop.com',
            LOG_LEVEL: 'debug',
            ...liveRlsBindings,
          },
          // NOTE: DATABASE_URL + CLERK_SECRET_KEY intentionally NOT set here.
          // Tests must either mock them or use a real .dev.vars + integration mode.
          //
          // R-J-S2 (260602) · nodejs_compat enables require() inside workerd so CJS
          // transitive deps (snakecase-keys from @clerk/backend) load without the
          // "Cannot use require() to import an ES Module" failure that was breaking
          // 4 suites (auth, entitlement, health, request-access). These suites import
          // ../index (full Hono app) which pulls the Clerk middleware chain.
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
    // Reasonable defaults
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
