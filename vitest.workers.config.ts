// vitest.workers.config.ts · Vitest config for src/workers/ tests
//
// Uses @cloudflare/vitest-pool-workers to run tests inside a Cloudflare Workers
// runtime (workerd) so the test environment matches production exactly.
//
// Run:    npm run test:workers
// Watch:  npm run test:workers:watch

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tests that exercise LLM paths inject an AI mock per request, so the pool uses a derived config
// without the production [ai] binding. The current pool embeds a runtime newer than the configured
// compatibility date; the derived file is regenerated on every run to prevent config drift.
const TEST_WRANGLER_PATH = path.resolve(__dirname, 'wrangler.test.generated.toml');
writeFileSync(
  TEST_WRANGLER_PATH,
  readFileSync(path.resolve(__dirname, 'wrangler.toml'), 'utf8').replace('[ai]\nbinding = "AI"\n', ''),
);

const liveRlsBindings =
  process.env.XLOOOP_RUN_LIVE_RLS === '1'
    ? {
        XLOOOP_RUN_LIVE_RLS: '1',
        ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
      }
    : {};

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: TEST_WRANGLER_PATH },
    isolatedStorage: true,
    miniflare: {
      bindings: {
        ENVIRONMENT: 'development',
        CLERK_JWKS_CACHE_TTL_SECONDS: '300',
        ALLOWED_ORIGIN_PATTERN: 'https://*.xlooop.com',
        LOG_LEVEL: 'debug',
        ...liveRlsBindings,
      },
      compatibilityFlags: ['nodejs_compat'],
    },
  })],
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
    // Reasonable defaults
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
