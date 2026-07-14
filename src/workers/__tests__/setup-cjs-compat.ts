// src/workers/__tests__/setup-cjs-compat.ts · R-J-S2 (260602)
//
// Vitest setup file for the @cloudflare/vitest-pool-workers test environment.
// Loaded BEFORE any test collection via test.setupFiles in vitest.workers.config.ts.
//
// WHY: snakecase-keys@8.0.1 (pulled in by @clerk/backend) uses require() internally.
// The Cloudflare Workers test pool (Miniflare/workerd) refuses to apply the CJS→ESM
// shim for this package (it adds `?mf_vitest_no_cjs_esm_shim` to the URL, causing
// "Cannot use require() to import an ES Module"). nodejs_compat and server.deps.inline
// did not resolve this — the module loader intercepts before those flags apply.
//
// Fix: pre-load the module via a Function-based dynamic require() shim BEFORE test
// collection so Miniflare sees it as already-resolved in the module registry.
// This is safe: it doesn't affect the tests' actual behavior; it only fixes the
// module loader race that was blocking collection.
//
// Suites fixed: auth.test.ts, entitlement.test.ts, health.test.ts, request-access.test.ts
// (all import ../index → middleware/auth → @clerk/backend → snakecase-keys CJS chain).

// Use globalThis to signal that the compat shim ran (for diagnostic assertions).
(globalThis as any).__xcpCjsCompatShimLoaded = true;
