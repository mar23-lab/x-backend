#!/usr/bin/env node
// verify-sentry-wired.mjs · A-W6 · production observability wiring freeze (260707).
//
// WHY: src/workers/sentry.ts is a complete, PII-redacting error-capture surface, but for years it had
// ZERO call sites — a dormant module capturing nothing. A-W6 wired it at the central error chokepoint so
// every 5xx (a real server fault, not an expected 4xx) is captured, and buffered telemetry is flushed
// before the Workers isolate suspends. This gate freezes that wiring so a refactor can't silently return
// the worker to "errors vanish into the void". Dormant-safe: no-op until SENTRY_DSN is bound (operator).
//
// TWO teeth:
//   T1 — middleware/error.ts errorEnvelope captures 5xx via captureException (imported from ../sentry).
//   T2 — index.ts app.onError flushes buffered telemetry (waitUntil(sentryFlush())).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ERROR_MW = 'src/workers/middleware/error.ts';
const INDEX = 'src/workers/index.ts';

const fail = [];
const read = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { fail.push(`${rel} · not found`); return null; }
  return fs.readFileSync(abs, 'utf8');
};

// T1 · the central error chokepoint captures 5xx.
const mw = read(ERROR_MW);
if (mw) {
  if (!/from '\.\.\/sentry'/.test(mw) || !/captureException\(/.test(mw)) {
    fail.push(`${ERROR_MW} · errorEnvelope no longer imports/calls captureException — 5xx server faults are not captured`);
  }
  if (!/status >= 500/.test(mw)) {
    fail.push(`${ERROR_MW} · the 5xx capture guard (status >= 500) is gone — either capturing nothing, or capturing expected 4xx noise`);
  }
}

// T2 · the global error handler flushes buffered telemetry (Workers don't auto-flush).
const idx = read(INDEX);
if (idx) {
  if (!/sentryFlush\(\)/.test(idx) || !/waitUntil\(\s*sentryFlush\(\)\s*\)/.test(idx)) {
    fail.push(`${INDEX} · app.onError no longer flushes Sentry via executionCtx.waitUntil(sentryFlush()) — buffered 5xx telemetry can be lost when the isolate suspends`);
  }
  // T3 (A-W6 activation) · the exported handler is wrapped with Sentry.withSentry(sentryOptions, …) —
  // @sentry/cloudflare has no standalone init(), so withSentry IS the init path. Dropping the wrapper
  // returns the worker to "SDK never initialized → captureException always hits the console fallback".
  if (!/Sentry\.withSentry\(/.test(idx) || !/sentryOptions/.test(idx)) {
    fail.push(`${INDEX} · the exported handler is no longer wrapped with Sentry.withSentry(sentryOptions, …) — the SDK is never initialized, so captures silently fall back to console`);
  }
}

// T4 (F13 fix) · isSentryActive() must probe the DSN, not merely the client. withSentry binds a client on
// EVERY request even with SENTRY_DSN unbound, so `!!getClient()` is always true and proves nothing (the
// /health sentry_active field would read true before activation). The honest signal is getClient()?.getDsn().
const sentrySrc = read('src/workers/sentry.ts');
if (sentrySrc) {
  // Check the FUNCTION BODY, not the whole file — the doc comment also mentions getDsn, so a whole-file
  // match would false-pass when the actual code regresses to getClient()-only.
  const fn = sentrySrc.match(/export function isSentryActive\([^)]*\)\s*:\s*boolean\s*\{[\s\S]*?\n\}/);
  if (!fn) {
    fail.push('src/workers/sentry.ts · isSentryActive() not found/exported');
  } else if (!/getClient\(\)\??\.getDsn\(\)/.test(fn[0])) {
    fail.push('src/workers/sentry.ts · isSentryActive() no longer checks getClient()?.getDsn() — a DSN-less client is still truthy under withSentry, so the activation signal (and the console-fallback guard) would silently lie');
  }
}

if (fail.length) {
  console.error('✗ sentry-wired · FAIL — production error observability regressed to dormant:');
  for (const v of fail) console.error(`    ${v}`);
  console.error('  Every 5xx must be captured (PII-redacted) + flushed. sentry.ts is dormant-safe until SENTRY_DSN is bound.');
  process.exit(1);
}

console.log('☑ sentry-wired · PASS · 5xx captured at errorEnvelope · flushed in app.onError · dormant-safe until SENTRY_DSN set');
process.exit(0);
