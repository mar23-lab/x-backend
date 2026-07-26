#!/usr/bin/env node

import {
  extractFrontendSha,
  resolveSentryRelease,
  sentryBootstrap,
} from '../functions/_lib/frontend-release-provenance.js';

const exactSha = 'a'.repeat(40);
const legacyRelease = 'legacy-configured-release';
const exactHtml = `<script>window.__XLOOP_FRONTEND_SHA="${exactSha}";</script>`;
const invalidHtml = '<script>window.__XLOOP_FRONTEND_SHA="deadbee";</script>';
const legacyHtml = '<html><head></head><body></body></html>';
const env = {
  SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
  SENTRY_ENVIRONMENT: 'production',
  SENTRY_RELEASE: legacyRelease,
  SENTRY_SAMPLE_RATE: '0.25',
  SENTRY_TRACES_SAMPLE_RATE: '0.05',
};

const checks = [
  ['extract exact artifact SHA', extractFrontendSha(exactHtml) === exactSha],
  ['artifact SHA overrides mutable release', resolveSentryRelease(exactHtml, legacyRelease) === exactSha],
  ['legacy artifact uses configured release', resolveSentryRelease(legacyHtml, legacyRelease) === legacyRelease],
  ['malformed declared SHA fails closed', resolveSentryRelease(invalidHtml, legacyRelease) === ''],
  ['missing DSN emits no bootstrap', sentryBootstrap({}, exactHtml) === ''],
  ['bootstrap carries exact artifact release', sentryBootstrap(env, exactHtml).includes(`window.SENTRY_RELEASE="${exactSha}"`)],
  ['bootstrap excludes stale release', !sentryBootstrap(env, exactHtml).includes(legacyRelease)],
  ['malformed declaration excludes stale release', !sentryBootstrap(env, invalidHtml).includes('SENTRY_RELEASE')],
];

const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
if (failed.length) {
  console.error(`verify-pages-sentry-release · FAIL · ${failed.join(', ')}`);
  process.exit(1);
}

console.log(`verify-pages-sentry-release · PASS ${checks.length}/${checks.length} exact-artifact and legacy-fallback checks`);
